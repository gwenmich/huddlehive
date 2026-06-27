from routes.spotify import get_valid_token

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
    return response.json()


def get_ethical_links(artist_name):
    search_response = requests.get(
        "https://musicbrainz.org/ws/2/artist/",
        params={"query": artist_name, "fmt": "json"},
        headers={"User-Agent": "FanCheck/1.0 (Huddlehive hackathon project)"}
    )

    results = search_response.json()

    if not results["artists"]:
        return None

    mbid = results["artists"][0]["id"]

    detail_response = requests.get(
        f"https://musicbrainz.org/ws/2/artist/{mbid}",
        params={"inc": "url-rels", "fmt": "json"},
        headers={"User-Agent": "FanCheck/1.0 (Huddlehive hackathon project)"}
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
    user = User.query.get(user_id)

    if not user.spotify_access_token:
        return jsonify({"error": "Spotify not connected"}), 400

    token = get_valid_token(user)

    top_artists_data = spotify_get("/me/top/artists?limit=10&time_range=medium_term", token)
    top_tracks_data = spotify_get("/me/top/tracks?limit=20&time_range=medium_term", token)
    profile_data = spotify_get("/me", token)

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
            "estimated_earnings_from_you_usd": estimated_earnings,
            "image": artist["images"][0]["url"] if artist["images"] else None,
            "spotify_url": artist["external_urls"]["spotify"],
            "ethical_alternatives": ethical_links
        })


    yearly_subscription_cost = 11.99 * 12
    percentage_to_artists = round(
        (total_estimated_earnings / yearly_subscription_cost) * 100, 1
    )

    summary = {
        "total_estimated_paid_to_artists_usd": round(total_estimated_earnings, 2),
        "yearly_spotify_subscription_gbp": round(11.99 * 12, 2),
        "percentage_reaching_artists": f"{percentage_to_artists}%",
        "top_tracks_count": len(top_tracks_data.get("items", [])),
        "currency_note": "Artist payouts are calculated in USD — the industry standard. Your subscription cost is shown in GBP."
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
            "spotify_per_stream_usd": SPOTIFY_PAYOUT_PER_STREAM,
            "apple_music_per_stream_usd": 0.006,
            "tidal_per_stream_usd": 0.010,
            "bandcamp_artist_cut_percent": 82,
            "note": "UK rates based on 2026 industry averages. Actual payouts vary."
        }
    })