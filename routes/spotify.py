import os
import requests
from datetime import datetime, timezone, timedelta
from urllib.parse import urlencode

from flask import Blueprint, redirect, request, jsonify, current_app
from flask_jwt_extended import decode_token
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

from models import User
from extensions import db

spotify_bp = Blueprint("spotify", __name__)

SCOPES = "user-top-read user-read-recently-played user-read-private"


def _get_config():
    return {
        "client_id": os.getenv("SPOTIFY_CLIENT_ID"),
        "client_secret": os.getenv("SPOTIFY_CLIENT_SECRET"),
        "redirect_uri": os.getenv(
            "SPOTIFY_REDIRECT_URI",
            "http://127.0.0.1:5000/auth/spotify/callback",
        ),
        "frontend_url": os.getenv("FRONTEND_URL", "http://127.0.0.1:5000").rstrip("/"),
    }


def _serializer():
    return URLSafeTimedSerializer(current_app.config["SECRET_KEY"])


def _make_state(user_id, frontend_url):
    return _serializer().dumps(
        {"user_id": str(user_id), "frontend_url": frontend_url.rstrip("/")},
        salt="spotify-oauth-state",
    )


def _read_state(state):
    return _serializer().loads(state, salt="spotify-oauth-state", max_age=600)


def _get_request_token():
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        return auth_header.split(None, 1)[1]

    return request.args.get("token")


def _get_user_from_token():
    token = _get_request_token()

    if not token:
        return None, jsonify({"error": "Authentication token required"}), 401

    try:
        decoded = decode_token(token)
        user_id = decoded.get("sub") or decoded.get("identity")
    except Exception as e:
        return None, jsonify({"error": f"Invalid login token: {str(e)}"}), 401

    user = User.query.get(user_id)

    if not user:
        return None, jsonify({"error": "User not found"}), 404

    return user, None, None


def _error_redirect(error, description="Spotify connection failed.", frontend_url=None):
    config = _get_config()
    base = (frontend_url or config["frontend_url"]).rstrip("/")

    query = urlencode(
        {
            "spotify": "failed",
            "spotify_error": error,
            "spotify_error_description": description,
        }
    )

    return redirect(f"{base}/pages/dashboard.html?{query}")


@spotify_bp.route("/auth/spotify")
def spotify_login():
    config = _get_config()

    if not config["client_id"] or not config["client_secret"]:
        return jsonify({"error": "Spotify credentials are missing"}), 500

    user, error_response, status = _get_user_from_token()
    if error_response:
        return error_response, status

    frontend_url = (
        request.args.get("frontend_url")
        or request.headers.get("Origin")
        or config["frontend_url"]
    ).rstrip("/")

    state = _make_state(user.id, frontend_url)

    params = {
        "client_id": config["client_id"],
        "response_type": "code",
        "redirect_uri": config["redirect_uri"],
        "scope": SCOPES,
        "state": state,
        "show_dialog": "true",
    }

    return redirect(f"https://accounts.spotify.com/authorize?{urlencode(params)}")


@spotify_bp.route("/auth/spotify/callback")
def spotify_callback():
    config = _get_config()

    error = request.args.get("error")
    error_description = request.args.get("error_description")
    code = request.args.get("code")
    state = request.args.get("state")

    if error:
        return _error_redirect(error, error_description or "Spotify authorization failed.")

    if not code:
        return _error_redirect("no_code", "Spotify did not return an authorization code.")

    if not state:
        return _error_redirect("missing_state", "Spotify did not return OAuth state.")

    try:
        state_data = _read_state(state)
    except SignatureExpired:
        return _error_redirect("expired_state", "Spotify login expired. Please try again.")
    except BadSignature:
        return _error_redirect("invalid_state", "Spotify OAuth state is invalid. Please try again.")

    user_id = state_data.get("user_id")
    frontend_url = state_data.get("frontend_url") or config["frontend_url"]

    user = User.query.get(user_id)

    if not user:
        return _error_redirect("user_not_found", "User account could not be found.", frontend_url)

    try:
        response = requests.post(
            "https://accounts.spotify.com/api/token",
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": config["redirect_uri"],
            },
            auth=(config["client_id"], config["client_secret"]),
            timeout=15,
        )
    except requests.RequestException:
        return _error_redirect(
            "spotify_request_failed",
            "Could not contact Spotify. Please try again.",
            frontend_url,
        )

    try:
        token_data = response.json()
    except ValueError:
        return _error_redirect(
            "invalid_spotify_response",
            "Spotify returned an invalid response.",
            frontend_url,
        )

    if response.status_code != 200 or "error" in token_data:
        return _error_redirect(
            token_data.get("error", "token_exchange_failed"),
            token_data.get("error_description", "Spotify token exchange failed."),
            frontend_url,
        )

    user.spotify_access_token = token_data["access_token"]
    user.spotify_refresh_token = token_data.get("refresh_token")
    user.spotify_token_expires_at = datetime.now(timezone.utc) + timedelta(
        seconds=token_data.get("expires_in", 3600)
    )

    db.session.commit()

    return redirect(f"{frontend_url}/pages/dashboard.html?spotify=connected")


def refresh_spotify_token(user):
    config = _get_config()

    if not user.spotify_refresh_token:
        return None

    try:
        response = requests.post(
            "https://accounts.spotify.com/api/token",
            data={
                "grant_type": "refresh_token",
                "refresh_token": user.spotify_refresh_token,
            },
            auth=(config["client_id"], config["client_secret"]),
            timeout=15,
        )
    except requests.RequestException:
        return None

    try:
        token_data = response.json()
    except ValueError:
        return None

    if response.status_code != 200 or "error" in token_data:
        return None

    user.spotify_access_token = token_data["access_token"]
    user.spotify_token_expires_at = datetime.now(timezone.utc) + timedelta(
        seconds=token_data.get("expires_in", 3600)
    )

    db.session.commit()
    return user.spotify_access_token


def get_valid_token(user):
    if not user.spotify_access_token:
        return None

    expires_at = user.spotify_token_expires_at

    if expires_at and expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)

    if not expires_at or datetime.now(timezone.utc) >= expires_at:
        return refresh_spotify_token(user)

    return user.spotify_access_token


def _spotify_get(user, url, params=None):
    spotify_token = get_valid_token(user)

    if not spotify_token:
        return None, jsonify({"error": "Spotify is not connected"}), 400

    try:
        response = requests.get(
            url,
            headers={"Authorization": f"Bearer {spotify_token}"},
            params=params or {},
            timeout=15,
        )
    except requests.RequestException:
        return None, jsonify({"error": "Could not contact Spotify"}), 502

    try:
        data = response.json()
    except ValueError:
        data = {"raw": response.text}

    if response.status_code != 200:
        return None, jsonify(
            {
                "error": "Spotify API request failed",
                "spotify_status": response.status_code,
                "spotify_response": data,
            }
        ), response.status_code

    return data, None, None


@spotify_bp.route("/api/spotify/status")
@spotify_bp.route("/spotify/status")
def spotify_status():
    user, error_response, status = _get_user_from_token()
    if error_response:
        return error_response, status

    return jsonify(
        {
            "connected": bool(user.spotify_access_token),
            "has_refresh_token": bool(user.spotify_refresh_token),
            "expires_at": user.spotify_token_expires_at.isoformat()
            if user.spotify_token_expires_at
            else None,
        }
    ), 200


@spotify_bp.route("/api/spotify/artists")
@spotify_bp.route("/api/spotify/top-artists")
@spotify_bp.route("/spotify/artists")
@spotify_bp.route("/spotify/top-artists")
def top_artists():
    user, error_response, status = _get_user_from_token()
    if error_response:
        return error_response, status

    data, error_response, status = _spotify_get(
        user,
        "https://api.spotify.com/v1/me/top/artists",
        {"limit": 10, "time_range": "medium_term"},
    )

    if error_response:
        return error_response, status

    artists = []

    for artist in data.get("items", []):
        images = artist.get("images") or []

        artists.append(
            {
                "id": artist.get("id"),
                "name": artist.get("name"),
                "genres": artist.get("genres", []),
                "image": images[0].get("url") if images else None,
                "spotify_url": artist.get("external_urls", {}).get("spotify"),
                "popularity": artist.get("popularity"),
            }
        )

    return jsonify(
        {
            "artists": artists,
            "items": artists,
            "connected": True,
        }
    ), 200


@spotify_bp.route("/api/spotify/recently-played")
@spotify_bp.route("/spotify/recently-played")
def recently_played():
    user, error_response, status = _get_user_from_token()
    if error_response:
        return error_response, status

    data, error_response, status = _spotify_get(
        user,
        "https://api.spotify.com/v1/me/player/recently-played",
        {"limit": 10},
    )

    if error_response:
        return error_response, status

    return jsonify(data), 200


@spotify_bp.route("/api/spotify/profile")
@spotify_bp.route("/spotify/profile")
def spotify_profile():
    user, error_response, status = _get_user_from_token()
    if error_response:
        return error_response, status

    data, error_response, status = _spotify_get(
        user,
        "https://api.spotify.com/v1/me",
    )

    if error_response:
        return error_response, status

    return jsonify(data), 200


@spotify_bp.route("/api/spotify/disconnect", methods=["POST"])
@spotify_bp.route("/spotify/disconnect", methods=["POST"])
def spotify_disconnect():
    user, error_response, status = _get_user_from_token()
    if error_response:
        return error_response, status

    user.spotify_access_token = None
    user.spotify_refresh_token = None
    user.spotify_token_expires_at = None

    db.session.commit()

    return jsonify({"message": "Spotify disconnected", "connected": False}), 200