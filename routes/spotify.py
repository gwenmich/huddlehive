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

SCOPES = "user-top-read user-read-recently-played user-read-private"


@spotify_bp.route("/auth/spotify")
def spotify_login():
    token = request.args.get("token")

    if not token:
        return jsonify({"error": "Missing token"}), 401

    try:
        decoded = decode_token(token)
        user_id = decoded["sub"]
    except Exception:
        return jsonify({"error": "Invalid token"}), 401

    params = {
        "client_id": SPOTIFY_CLIENT_ID,
        "response_type": "code",
        "redirect_uri": SPOTIFY_REDIRECT_URI,
        "scope": SCOPES,
        "state": user_id,
    }

    spotify_auth_url = "https://accounts.spotify.com/authorize?" + urlencode(params)
    return redirect(spotify_auth_url)


@spotify_bp.route("/auth/spotify/callback")
def spotify_callback():
    code = request.args.get("code")
    user_id = request.args.get("state")

    if not code or not user_id:
        return jsonify({"error": "Missing code or state"}), 400

    token_response = requests.post(
        "https://accounts.spotify.com/api/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": SPOTIFY_REDIRECT_URI,
        },
        auth=(SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET),
    )

    token_data = token_response.json()

    if "error" in token_data:
        return jsonify({"error": token_data["error"]}), 400

    user = User.query.get(user_id)
    if not user:
        return jsonify({"error": "User not found"}), 404

    user.spotify_access_token = token_data["access_token"]
    user.spotify_refresh_token = token_data["refresh_token"]
    user.spotify_token_expires_at = datetime.now(timezone.utc) + timedelta(
        seconds=token_data["expires_in"]
    )
    db.session.commit()

    return redirect("/pages/dashboard.html")


def refresh_spotify_token(user):
    response = requests.post(
        "https://accounts.spotify.com/api/token",
        data={
            "grant_type": "refresh_token",
            "refresh_token": user.spotify_refresh_token,
        },
        auth=(SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET),
    )

    token_data = response.json()
    user.spotify_access_token = token_data["access_token"]
    user.spotify_token_expires_at = datetime.now(timezone.utc) + timedelta(
        seconds=token_data["expires_in"]
    )
    db.session.commit()


def get_valid_token(user):
    if datetime.now(timezone.utc) >= user.spotify_token_expires_at:
        refresh_spotify_token(user)
    return user.spotify_access_token