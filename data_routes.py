import asyncio
import logging
from datetime import datetime, timedelta

from flask import Blueprint, jsonify, request
from flask_jwt_extended import jwt_required

from data_confidence import (
    DATA_POINTS,
    data_point_to_dict,
    get_any_data_point,
    refresh_all_data_points,
    safe_default_for_data_point,
)

logger = logging.getLogger(__name__)

data_bp = Blueprint("data", __name__)


def _run_async(coro):
    try:
        return asyncio.run(coro)
    except RuntimeError:
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(coro)
        finally:
            loop.close()


def _data_point_meta():
    return {item["key"]: item for item in DATA_POINTS}


def _is_stale(record, max_age_days=1):
    if not record or not record.last_updated:
        return True
    return record.last_updated < datetime.now() - timedelta(days=max_age_days)


def _record_or_default(key):
    meta = _data_point_meta().get(key)
    if not meta:
        return None
    record = get_any_data_point(key)
    if record:
        payload = data_point_to_dict(record)
        payload["stale"] = _is_stale(record)
        return payload
    payload = safe_default_for_data_point(meta)
    payload["stale"] = True
    return payload


@data_bp.route("/data/confidence", methods=["GET"])
def list_confidence_data():
    try:
        return jsonify({
            "freshness_window_hours": 24,
            "data_points": [
                _record_or_default(data_point["key"])
                for data_point in DATA_POINTS
            ],
        })
    except Exception:
        logger.exception("Could not list data confidence records")
        return jsonify({
            "freshness_window_hours": 24,
            "data_points": [safe_default_for_data_point(data_point) for data_point in DATA_POINTS],
            "error": "Data confidence records are temporarily unavailable.",
        }), 200


@data_bp.route("/data/confidence/<key>", methods=["GET"])
def get_confidence_data(key):
    try:
        payload = _record_or_default(key)
        if not payload:
            return jsonify({"error": "Unknown data point key."}), 404
        return jsonify(payload)
    except Exception:
        logger.exception("Could not get data confidence record %s", key)
        meta = _data_point_meta().get(key)
        if not meta:
            return jsonify({"error": "Unknown data point key."}), 404
        payload = safe_default_for_data_point(meta)
        payload["error"] = "Data confidence record is temporarily unavailable."
        return jsonify(payload), 200


@data_bp.route("/data/confidence/refresh", methods=["POST"])
@jwt_required()
def refresh_confidence_data():
    payload = request.get_json(silent=True) or {}
    key = payload.get("key")
    keys = payload.get("keys")
    force = bool(payload.get("force", False))
    try:
        limit = int(payload.get("limit", 1))
    except (TypeError, ValueError):
        limit = 1
    limit = max(1, min(limit, 3))

    selected = []
    known = _data_point_meta()
    if key:
        selected = [key]
    elif isinstance(keys, list):
        selected = [item for item in keys if isinstance(item, str)]

    unknown = [item for item in selected if item not in known]
    if unknown:
        return jsonify({"error": "Unknown data point key.", "unknown_keys": unknown}), 400

    try:
        results = _run_async(refresh_all_data_points(
            max_age_days=0 if force else 1,
            keys=selected or None,
            limit=None if selected else limit,
        ))
        return jsonify({
            "message": "Data confidence refresh complete.",
            "freshness_window_hours": 24,
            "refresh_limit": None if selected else limit,
            "results": results,
        })
    except Exception:
        logger.exception("Could not refresh data confidence records")
        return jsonify({
            "error": "Data confidence refresh failed safely.",
            "results": [],
        }), 200
