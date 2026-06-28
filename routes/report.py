import requests
from flask import Blueprint, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity

from models import User
from routes.spotify import get_valid_token

report_bp = Blueprint("report", __name__)

SPOTIFY_API_BASE = "https://api.spotify.com/v1"

# Average per-stream payout in GBP — publicly reported industry figure
SPOTIFY_PAYOUT_PER_STREAM = 0.0035


def spotify_get(endpoint, token):
    response = requests.get(
        f"{SPOTIFY_API_BASE}{endpoint}",
        headers={"Authorization": f"Bearer {token}"}
    )
    try:
        data = response.json()
    except ValueError:
        return {"error": "Invalid Spotify API response"}

    if response.status_code != 200:
        return {"error": data.get("error") or data.get("error_description") or "Spotify API request failed"}

    return data


def get_ethical_links(artist_name):
    search_response = requests.get(
        "https://musicbrainz.org/ws/2/artist/",
        params={"query": artist_name, "fmt": "json"},
        headers={"User-Agent": "FanCheck/1.0 (FanCheck hackathon project)"}
    )

    results = search_response.json()

    if not results["artists"]:
        return None

    mbid = results["artists"][0]["id"]

    detail_response = requests.get(
        f"https://musicbrainz.org/ws/2/artist/{mbid}",
        params={"inc": "url-rels", "fmt": "json"},
        headers={"User-Agent": "FanCheck/1.0 (FanCheck hackathon project)"}
    )

    details = detail_response.json()
    links = {}

    for relation in details.get("relations", []):
        url = relation.get("url", {}).get("resource", "")
        rel_type = relation.get("type", "")

        if "bandcamp" in url:
            links["bandcamp"] = url
        elif rel_type == "official homepage":
            links["official_site"] = url

    return links if links else None


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
        return jsonify({"error": "Spotify not connected"}), 400

    token = get_valid_token(user)
    if not token:
        return jsonify({"error": "Spotify token refresh failed"}), 400

    top_artists_data = spotify_get("/me/top/artists?limit=10&time_range=medium_term", token)
    top_tracks_data = spotify_get("/me/top/tracks?limit=20&time_range=medium_term", token)
    profile_data = spotify_get("/me", token)

    if not isinstance(top_artists_data, dict) or top_artists_data.get("error"):
        return jsonify({"error": "Failed to fetch Spotify artist data"}), 502
    if not isinstance(top_tracks_data, dict) or top_tracks_data.get("error"):
        return jsonify({"error": "Failed to fetch Spotify track data"}), 502
    if not isinstance(profile_data, dict) or profile_data.get("error"):
        return jsonify({"error": "Failed to fetch Spotify profile data"}), 502

    artists = []
    total_estimated_earnings = 0

    for artist in top_artists_data.get("items", []):
        estimated_streams = artist["popularity"] * 10000
        estimated_earnings = round(estimated_streams * SPOTIFY_PAYOUT_PER_STREAM, 2)
        total_estimated_earnings += estimated_earnings

        ethical_links = get_ethical_links(artist["name"])

        artists.append({
            "name": artist["name"],
            "popularity_score": artist["popularity"],
            "estimated_streams_from_you": estimated_streams,
            "estimated_earnings_from_you_gbp": estimated_earnings,
            "image": artist["images"][0]["url"] if artist["images"] else None,
            "spotify_url": artist["external_urls"]["spotify"],
            "ethical_alternatives": ethical_links
        })


    yearly_subscription_cost = 11.99 * 12
    percentage_to_artists = round(
        (total_estimated_earnings / yearly_subscription_cost) * 100, 1
    )

    summary = {
        "total_estimated_paid_to_artists_gbp": round(total_estimated_earnings, 2),
        "yearly_spotify_subscription_gbp": round(yearly_subscription_cost, 2),
        "percentage_reaching_artists": f"{percentage_to_artists}%",
        "top_tracks_count": len(top_tracks_data.get("items", [])),
        "currency_note": "Artist payouts are estimated in GBP to match this report. Your subscription cost is also shown in GBP."
    }


    return jsonify({
        "user": {
            "email": user.email,
            "spotify_display_name": profile_data.get("display_name"),
            "spotify_plan": profile_data.get("product"),
        },
        "top_artists": artists,
        "summary": summary,
        "payout_comparison": {
            "spotify_per_stream_gbp": SPOTIFY_PAYOUT_PER_STREAM,
            "apple_music_per_stream_gbp": 0.006,
            "tidal_per_stream_gbp": 0.010,
            "bandcamp_artist_cut_percent": 82,
            "note": "UK rates based on 2026 industry averages. Actual payouts vary."
        }
    })
