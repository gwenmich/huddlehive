import base64
import json
import os
import requests
from datetime import datetime, timezone, timedelta
from urllib.parse import urlencode
from flask import Blueprint, redirect, request, jsonify
from flask_jwt_extended import decode_token
from models import User
from extensions import db

spotify_bp = Blueprint("spotify", __name__)

SPOTIFY_CLIENT_ID = os.getenv("SPOTIFY_CLIENT_ID")
SPOTIFY_CLIENT_SECRET = os.getenv("SPOTIFY_CLIENT_SECRET")
SPOTIFY_REDIRECT_URI = os.getenv("SPOTIFY_REDIRECT_URI")
FRONTEND_BASE_URL = os.getenv("FRONTEND_URL")

SCOPES = "user-top-read user-read-recently-played user-read-private"


def _pack_state(token, frontend_url=None):
    payload = {"token": token}
    if frontend_url:
        payload["frontend_url"] = frontend_url.rstrip('/')
    raw = json.dumps(payload, separators=(",", ":")).encode('utf-8')
    return base64.urlsafe_b64encode(raw).decode('utf-8').rstrip('=')


def _unpack_state(state_value):
    if not state_value:
        return {}

    try:
        padded = state_value + '=' * (-len(state_value) % 4)
        raw = base64.urlsafe_b64decode(padded.encode('utf-8'))
        payload = json.loads(raw.decode('utf-8'))
        if isinstance(payload, dict):
            return payload
    except Exception:
        pass

    return {"token": state_value}


def _get_request_token():
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        return auth_header.split(None, 1)[1]
    return request.args.get("token")


def _get_redirect_uri():
    if SPOTIFY_REDIRECT_URI:
        return SPOTIFY_REDIRECT_URI
    return f"{request.url_root.rstrip('/')}/auth/spotify/callback"


@spotify_bp.route("/auth/spotify")
def spotify_login():
    token = _get_request_token()
    if not token:
        return jsonify({"error": "Authentication token required"}), 401

    if not SPOTIFY_CLIENT_ID or not SPOTIFY_CLIENT_SECRET:
        return jsonify({"error": "Spotify client credentials are not configured"}), 500

    redirect_uri = _get_redirect_uri()
    if not redirect_uri:
        return jsonify({"error": "Spotify redirect URI is not configured"}), 500

    frontend_url = request.args.get('frontend_url') or request.headers.get('Origin') or request.host_url.rstrip('/')
    state = _pack_state(token, frontend_url)

    params = {
        "client_id": SPOTIFY_CLIENT_ID,
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "scope": SCOPES,
        "state": state,
    }
    spotify_auth_url = f"https://accounts.spotify.com/authorize?{urlencode(params)}"
    return redirect(spotify_auth_url)


def _get_frontend_base_url(frontend_url=None):
    if frontend_url:
        return frontend_url.rstrip('/')

    if FRONTEND_BASE_URL:
        return FRONTEND_BASE_URL.rstrip('/')

    origin = request.headers.get('Origin')
    if origin:
        return origin.rstrip('/')

    if request.host_url:
        return request.host_url.rstrip('/')

    return 'http://127.0.0.1:5001'


def _redirect_spotify_error(error, description=None, frontend_url=None):
    frontend_url = _get_frontend_base_url(frontend_url)
    params = {
        "spotify": "failed",
        "spotify_error": error,
    }
    if description:
        params["spotify_error_description"] = description
    query = urlencode(params)
    return redirect(f"{frontend_url}/pages/dashboard.html?{query}")


@spotify_bp.route("/auth/spotify/callback")
def spotify_callback():
    error = request.args.get("error")
    error_description = request.args.get("error_description")
    code = request.args.get("code")
    state = request.args.get("state")

    if error:
        state_payload = _unpack_state(state)
        frontend_url = state_payload.get("frontend_url")
        return _redirect_spotify_error(error, error_description, frontend_url)

    if not code:
        state_payload = _unpack_state(state)
        frontend_url = state_payload.get("frontend_url")
        return _redirect_spotify_error("no_code", "No authorization code was returned by Spotify.", frontend_url)
    if not state:
        return _redirect_spotify_error("missing_state", "The OAuth state parameter is missing.")

    state_payload = _unpack_state(state)
    token = state_payload.get("token")
    frontend_url = state_payload.get("frontend_url")

    if not token:
        return _redirect_spotify_error("invalid_state", "The OAuth state token could not be decoded.", frontend_url)

    try:
        decoded = decode_token(token)
        user_id = decoded.get("sub") or decoded.get("identity")
    except Exception:
        return _redirect_spotify_error("invalid_state", "The OAuth state token could not be decoded.", frontend_url)

    user = User.query.get(user_id)
    if not user:
        return _redirect_spotify_error("user_not_found", "The authenticated user no longer exists.", frontend_url)

    redirect_uri = _get_redirect_uri()
    token_response = requests.post(
        "https://accounts.spotify.com/api/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
        },
        auth=(SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET),
    )

    try:
        token_data = token_response.json()
    except ValueError:
        return _redirect_spotify_error("invalid_spotify_response", "Spotify returned an invalid token response.")

    if token_response.status_code != 200 or "error" in token_data:
        return _redirect_spotify_error(
            token_data.get("error") or "token_exchange_failed",
            token_data.get("error_description") or "Spotify token exchange failed.",
        )

    user.spotify_access_token = token_data["access_token"]
    user.spotify_refresh_token = token_data.get("refresh_token")
    user.spotify_token_expires_at = datetime.now(timezone.utc) + timedelta(
        seconds=token_data.get("expires_in", 0)
    )

    db.session.commit()
    frontend_url = state_payload.get("frontend_url")
    frontend_url = _get_frontend_base_url(frontend_url)
    return redirect(f"{frontend_url}/pages/dashboard.html?spotify=connected")


def refresh_spotify_token(user):
    if not user.spotify_refresh_token:
        return None

    response = requests.post(
        "https://accounts.spotify.com/api/token",
        data={
            "grant_type": "refresh_token",
            "refresh_token": user.spotify_refresh_token,
        },
        auth=(SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET),
    )

    try:
        token_data = response.json()
    except ValueError:
        return None

    if response.status_code != 200 or "error" in token_data:
        return None

    user.spotify_access_token = token_data["access_token"]
    user.spotify_token_expires_at = datetime.now(timezone.utc) + timedelta(
        seconds=token_data.get("expires_in", 0)
    )
    db.session.commit()
    return user.spotify_access_token


def get_valid_token(user):
    if not user.spotify_access_token:
        return None
    if not user.spotify_token_expires_at or datetime.now(timezone.utc) >= user.spotify_token_expires_at:
        return refresh_spotify_token(user)
    return user.spotify_access_token
