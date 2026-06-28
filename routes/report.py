import requests
from flask import Blueprint, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity

from models import User
from routes.spotify import get_valid_token

report_bp = Blueprint("report", __name__)

SPOTIFY_API_BASE = "https://api.spotify.com/v1"
SPOTIFY_PAYOUT_PER_STREAM = 0.0035


def spotify_get(endpoint, token):
    try:
        response = requests.get(
            f"{SPOTIFY_API_BASE}{endpoint}",
            headers={"Authorization": f"Bearer {token}"},
            timeout=15,
        )
    except requests.RequestException as e:
        return None, {"error": "network_error", "detail": str(e)}

    try:
        data = response.json()
    except ValueError:
        return None, {"error": "invalid_json", "spotify_status": response.status_code}

    if response.status_code == 401:
        return None, {
            "error": "spotify_token_rejected",
            "detail": data.get("error", {}).get("message", "Spotify rejected the token."),
            "action": "reconnect_spotify",
        }

    if response.status_code != 200:
        return None, {
            "error": "spotify_api_error",
            "detail": data.get("error", {}).get("message", "Spotify API request failed."),
            "spotify_status": response.status_code,
        }

    return data, None


def get_ethical_links(artist_name):
    try:
        search = requests.get(
            "https://musicbrainz.org/ws/2/artist/",
            params={"query": artist_name, "fmt": "json"},
            headers={"User-Agent": "FanCheck/1.0 (hackathon project)"},
            timeout=8,
        )
        artists = search.json().get("artists", [])
        if not artists:
            return None

        mbid = artists[0]["id"]
        detail = requests.get(
            f"https://musicbrainz.org/ws/2/artist/{mbid}",
            params={"inc": "url-rels", "fmt": "json"},
            headers={"User-Agent": "FanCheck/1.0 (hackathon project)"},
            timeout=8,
        )
        links = {}
        for rel in detail.json().get("relations", []):
            url = rel.get("url", {}).get("resource", "")
            if "bandcamp" in url:
                links["bandcamp"] = url
            elif rel.get("type") == "official homepage":
                links["official_site"] = url
        return links or None
    except Exception:
        # MusicBrainz is best-effort — never block the report
        return None


@report_bp.route("/report")
@jwt_required()
def get_report():
    user_id = get_jwt_identity()
    try:
        user_id = int(user_id)
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid user identity"}), 401

    user = User.query.get(user_id)
    if not user:
        return jsonify({"error": "User not found"}), 404

    if not user.spotify_access_token:
        return jsonify({"error": "Spotify not connected", "action": "connect_spotify"}), 401

    token = get_valid_token(user)
    if not token:
        return jsonify({
            "error": "Spotify token refresh failed",
            "detail": "Please reconnect Spotify.",
            "action": "reconnect_spotify",
        }), 401

    top_artists_data, err = spotify_get("/me/top/artists?limit=10&time_range=medium_term", token)
    if err:
        status = 401 if err.get("error") == "spotify_token_rejected" else 502
        return jsonify(err), status

    top_tracks_data, err = spotify_get("/me/top/tracks?limit=20&time_range=medium_term", token)
    if err:
        status = 401 if err.get("error") == "spotify_token_rejected" else 502
        return jsonify(err), status

    profile_data, err = spotify_get("/me", token)
    if err:
        status = 401 if err.get("error") == "spotify_token_rejected" else 502
        return jsonify(err), status

    artists = []
    total_estimated_earnings = 0

    for artist in top_artists_data.get("items", []):
        estimated_streams = artist.get("popularity", 0) * 10000
        estimated_earnings = round(estimated_streams * SPOTIFY_PAYOUT_PER_STREAM, 2)
        total_estimated_earnings += estimated_earnings
        images = artist.get("images") or []
        artists.append({
            "name": artist.get("name", ""),
            "popularity_score": artist.get("popularity", 0),
            "estimated_streams_from_you": estimated_streams,
            "estimated_earnings_from_you_gbp": estimated_earnings,
            "image": images[0]["url"] if images else None,
            "spotify_url": artist.get("external_urls", {}).get("spotify"),
            "ethical_alternatives": get_ethical_links(artist.get("name", "")),
        })

    yearly_subscription_cost = 11.99 * 12
    percentage_to_artists = round(
        (total_estimated_earnings / yearly_subscription_cost) * 100, 1
    ) if yearly_subscription_cost else 0

    return jsonify({
        "user": {
            "email": user.email,
            "spotify_display_name": profile_data.get("display_name"),
            "spotify_plan": profile_data.get("product"),
        },
        "top_artists": artists,
        "summary": {
            "total_estimated_paid_to_artists_gbp": round(total_estimated_earnings, 2),
            "yearly_spotify_subscription_gbp": round(yearly_subscription_cost, 2),
            "percentage_reaching_artists": f"{percentage_to_artists}%",
            "top_tracks_count": len(top_tracks_data.get("items", [])),
        },
        "payout_comparison": {
            "spotify_per_stream_gbp": SPOTIFY_PAYOUT_PER_STREAM,
            "apple_music_per_stream_gbp": 0.006,
            "tidal_per_stream_gbp": 0.010,
            "bandcamp_artist_cut_percent": 82,
            "note": "UK rates based on 2026 industry averages. Actual payouts vary.",
        },
    })