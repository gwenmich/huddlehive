import hashlib
import html
import json
import os
import re
import secrets
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse, urlunparse

from flask import Blueprint, jsonify, make_response, request
from flask_jwt_extended import get_jwt_identity, jwt_required, verify_jwt_in_request

from extensions import db
from models import SiteReport, TransactionAnalysis

extension_bp = Blueprint("extension", __name__)

CACHE_TTL_SECONDS = 24 * 60 * 60
RATE_LIMIT_WINDOW_SECONDS = 60
ANALYZE_LIMIT = 20
REPORT_LIMIT = 10
ADMIN_LIMIT = 60
MAX_REDACTED_TEXT_CHARS = 2000
MAX_DETECTED_PRICES = 20
MAX_CONTINUATIONS = 2
MAX_REPORT_NOTE_CHARS = 500
PREFLIGHT_VERSION = 1
PREFLIGHT_MIN_SCORE = 60
PREFLIGHT_ALLOWED_BANDS = {"HIGH", "MEDIUM"}
PREFLIGHT_POSITIVE_CATEGORIES = {
    "known_host",
    "url_transaction",
    "title_music",
    "text_music",
    "text_transaction",
    "price",
    "music_merch",
}
PREFLIGHT_ALLOWED_CATEGORIES = PREFLIGHT_POSITIVE_CATEGORIES | {"negative_path"}

_analysis_cache = {}
_rate_limits = {}

ALLOWED_RESULT_KEYS = {"summary", "estimate", "warnings", "alternatives", "detail_page"}
ALLOWED_CITATION_KEYS = {
    "source_id",
    "source_title",
    "source_label",
    "source_url",
    "source_domain",
    "source_type",
    "cited_excerpt",
    "supports",
    "source_verified_at",
    "source_page_age",
}


def _now():
    return datetime.now(timezone.utc)


def _now_iso():
    return _now().isoformat().replace("+00:00", "Z")


def _json_dumps(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True)


def _sha256(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _normalize_hostname(hostname):
    hostname = (hostname or "").strip().lower()
    if hostname.startswith("www."):
        hostname = hostname[4:]
    return hostname[:255]


def _parse_http_url(url):
    parsed = urlparse((url or "").strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    return parsed


def _safe_display_url(parsed):
    path = parsed.path or "/"
    return urlunparse((parsed.scheme, parsed.netloc, path, "", "", ""))


def _optional_user_id():
    try:
        verify_jwt_in_request(optional=True)
        identity = get_jwt_identity()
        return int(identity) if identity is not None else None
    except Exception:
        return None


def _client_key(user_id):
    if user_id:
        return f"user:{user_id}"
    forwarded = request.headers.get("X-Forwarded-For", "")
    ip = forwarded.split(",")[0].strip() if forwarded else request.remote_addr
    return f"ip:{ip or 'unknown'}"


def _check_rate_limit(bucket, user_id, limit):
    key = (bucket, _client_key(user_id))
    now = time.time()
    window_start, count = _rate_limits.get(key, (now, 0))
    if now - window_start > RATE_LIMIT_WINDOW_SECONDS:
        _rate_limits[key] = (now, 1)
        return True
    if count >= limit:
        return False
    _rate_limits[key] = (window_start, count + 1)
    return True


def _rate_limited():
    return jsonify({"error": "Rate limit exceeded. Please try again shortly."}), 429


def _env_bool(name, default):
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _base_url():
    return os.getenv("FAN_CHECK_BASE_URL", "https://fancheck.onrender.com").rstrip("/")


def _format_money(amount, currency):
    if amount is None:
        return None
    symbol = {"GBP": "£", "USD": "$", "EUR": "€"}.get((currency or "").upper(), "")
    return f"{symbol}{float(amount):.2f}" if symbol else f"{float(amount):.2f} {currency or ''}".strip()


def _first_price(detected_prices):
    if not isinstance(detected_prices, list):
        return None, None
    candidates = [p for p in detected_prices[:MAX_DETECTED_PRICES] if isinstance(p, dict)]
    totalish = [
        p
        for p in candidates
        if any(word in str(p.get("label", "") + " " + p.get("nearbyText", "")).lower() for word in ["total", "due", "checkout"])
    ]
    selected = (totalish or candidates or [None])[0]
    if not selected:
        return None, None
    amount = selected.get("amount")
    try:
        amount = float(amount) if amount is not None else None
    except (TypeError, ValueError):
        amount = None
    currency = selected.get("currency") or None
    return amount, currency


def _safe_string(value, max_len=500):
    if value is None:
        return None
    return str(value).strip()[:max_len]


def _safe_code_list(value, allowed=None, max_items=20, max_len=80):
    if not isinstance(value, list):
        return []
    cleaned = []
    for item in value:
        code = re.sub(r"[^A-Za-z0-9_.:-]", "_", str(item or ""))[:max_len]
        if not code:
            continue
        if allowed is not None and code not in allowed:
            continue
        if code not in cleaned:
            cleaned.append(code)
        if len(cleaned) >= max_items:
            break
    return cleaned


def _price_bucket(payload):
    amount, _currency = _first_price(payload.get("detectedPrices"))
    if amount is None:
        return "unknown"
    if amount < 25:
        return "under_25"
    if amount < 50:
        return "25_49"
    if amount < 100:
        return "50_99"
    if amount < 250:
        return "100_249"
    return "250_plus"


def _sanitize_preflight(value):
    if not isinstance(value, dict):
        return None
    try:
        version = int(value.get("version"))
    except (TypeError, ValueError):
        version = None
    try:
        score = int(value.get("score"))
    except (TypeError, ValueError):
        score = 0
    score = max(0, min(score, 100))
    band = _safe_string(value.get("band"), 20)
    categories = _safe_code_list(value.get("matchedSignalCategories"), PREFLIGHT_ALLOWED_CATEGORIES)
    return {
        "version": version,
        "score": score,
        "band": band,
        "reasons": _safe_code_list(value.get("reasons")),
        "matchedSignals": _safe_code_list(value.get("matchedSignals")),
        "matchedSignalCategories": categories,
        "shouldAnalyze": value.get("shouldAnalyze") is True,
    }


def _safe_failure(reason):
    return jsonify({
        "error": "FanCheck could not analyse this page yet.",
        "reason": reason,
        "anthropic_skipped": True,
    }), 400


def _validate_analysis_gate(payload):
    trigger = payload.get("trigger")
    if trigger != "user_click":
        payload["redactedText"] = ""
        return None, _safe_failure("trigger_missing")

    consent = payload.get("consent") if isinstance(payload.get("consent"), dict) else None
    if not consent or consent.get("confirmed") is not True:
        payload["redactedText"] = ""
        return None, _safe_failure("consent_missing")

    preflight = _sanitize_preflight(payload.get("preflight"))
    if not preflight:
        payload["redactedText"] = ""
        return None, _safe_failure("preflight_missing")

    positive_categories = [
        category for category in preflight["matchedSignalCategories"]
        if category in PREFLIGHT_POSITIVE_CATEGORIES
    ]
    if (
        preflight["version"] != PREFLIGHT_VERSION
        or preflight["shouldAnalyze"] is not True
        or preflight["band"] not in PREFLIGHT_ALLOWED_BANDS
        or preflight["score"] < PREFLIGHT_MIN_SCORE
        or len(positive_categories) < 2
    ):
        payload["redactedText"] = ""
        return preflight, _safe_failure("preflight_failed")

    scope = _safe_string(consent.get("scope"), 20)
    if scope not in {"site", "global"}:
        payload["redactedText"] = ""
        return preflight, _safe_failure("consent_missing")
    payload["consent"] = {
        "confirmed": True,
        "scope": scope,
        "hostname": _normalize_hostname(consent.get("hostname")),
    }
    payload["preflight"] = preflight
    return preflight, None


def _sanitize_search_context(payload, parsed):
    signals = payload.get("clientSignals") if isinstance(payload.get("clientSignals"), dict) else {}
    preferences = payload.get("preferences") if isinstance(payload.get("preferences"), dict) else {}
    title = re.sub(r"(?i)(order|booking|seat|section|row|card|account)[^\n]{0,80}", "", str(payload.get("title") or ""))
    title = re.sub(r"\b\d{4,}\b", "", title)
    return {
        "hostname": _normalize_hostname(parsed.hostname),
        "title_hint": title[:160],
        "known_domain": _safe_string(signals.get("knownDomain"), 120),
        "page_type_hint": _safe_string(signals.get("pageTypeHint"), 80),
        "purchase_type_hint": _safe_string(signals.get("purchaseTypeHint"), 80),
        "coarse_price_bucket": _price_bucket(payload),
        "preflight": {
            "version": (payload.get("preflight") or {}).get("version"),
            "band": (payload.get("preflight") or {}).get("band"),
            "categories": (payload.get("preflight") or {}).get("matchedSignalCategories", [])[:10],
        },
        "music_keywords": [str(k)[:40] for k in signals.get("musicKeywords", [])[:10]] if isinstance(signals.get("musicKeywords"), list) else [],
        "region": _safe_string(preferences.get("region"), 40),
    }


def _default_result(payload, parsed, source_status="unavailable", cache_status="none", message=None):
    amount, currency = _first_price(payload.get("detectedPrices"))
    signals = payload.get("clientSignals") if isinstance(payload.get("clientSignals"), dict) else {}
    purchase_type = signals.get("purchaseTypeHint") or "unknown"
    hostname = _normalize_hostname(parsed.hostname)
    detected_total = {
        "amount": amount,
        "currency": currency,
        "formatted": _format_money(amount, currency),
    }
    if amount is None:
        detected_total = {"amount": None, "currency": currency, "formatted": None}
    return {
        "summary": {
            "purchase_type": purchase_type if purchase_type in {"ticket", "merch", "streaming", "unknown"} else "unknown",
            "platform_name": signals.get("knownDomain") or hostname,
            "hostname": hostname,
            "detected_total": detected_total,
            "source_check_status": source_status,
            "cache_status": cache_status,
            "generated_at": _now_iso(),
        },
        "estimate": {
            "available": False,
            "display_style": "none",
            "base_price_range": None,
            "fee_range": None,
            "order_fee_range": None,
            "artist_share_estimate": None,
            "confidence": "low",
            "confidence_score": 0,
            "explanation": message or "Current source-backed estimates are unavailable for this page.",
        },
        "warnings": [
            {
                "type": "source",
                "severity": "info",
                "message": message or "FanCheck could not verify enough current source information to show a numerical estimate.",
            }
        ],
        "alternatives": _default_alternatives(purchase_type),
        "detail_page": {
            "headline": "FanCheck source check",
            "intro": "A source-backed estimate was not available for this transaction.",
            "cta_label": "Compare fairer options",
        },
    }


def _default_alternatives(purchase_type):
    if purchase_type == "merch":
        return [
            {"name": "Artist direct store", "type": "artist_direct", "url": None, "note": "Check the artist or label website for direct merch."},
            {"name": "Bandcamp", "type": "independent_store", "url": "https://bandcamp.com", "note": "Look for the artist on Bandcamp when available."},
        ]
    return [
        {"name": "Venue box office", "type": "venue", "url": None, "note": "Check the venue website for direct tickets."},
        {"name": "Official artist site", "type": "artist_direct", "url": None, "note": "Artist sites often link to official ticket sources."},
    ]


def _sanitize_result(candidate, payload, parsed, source_status, cache_status):
    base = _default_result(payload, parsed, source_status, cache_status)
    if not isinstance(candidate, dict):
        return base

    summary = candidate.get("summary") if isinstance(candidate.get("summary"), dict) else {}
    estimate = candidate.get("estimate") if isinstance(candidate.get("estimate"), dict) else {}

    for key, value in summary.items():
        if key in base["summary"]:
            base["summary"][key] = value
    for key, value in estimate.items():
        if key in base["estimate"]:
            base["estimate"][key] = value

    base["summary"]["hostname"] = _normalize_hostname(parsed.hostname)
    base["summary"]["source_check_status"] = source_status
    base["summary"]["cache_status"] = cache_status
    base["summary"]["generated_at"] = _now_iso()

    total = base["summary"].get("detected_total")
    if not isinstance(total, dict):
        amount, currency = _first_price(payload.get("detectedPrices"))
        total = {"amount": amount, "currency": currency, "formatted": _format_money(amount, currency)}
    base["summary"]["detected_total"] = {
        "amount": total.get("amount"),
        "currency": total.get("currency"),
        "formatted": total.get("formatted") or _format_money(total.get("amount"), total.get("currency")),
    }

    warnings = candidate.get("warnings")
    if isinstance(warnings, list):
        base["warnings"] = [
            {
                "type": _safe_string(w.get("type"), 40) or "source",
                "severity": _safe_string(w.get("severity"), 20) or "info",
                "message": _safe_string(w.get("message"), 300) or "Source-backed guidance is limited.",
            }
            for w in warnings[:5]
            if isinstance(w, dict)
        ]

    alternatives = candidate.get("alternatives")
    if isinstance(alternatives, list):
        base["alternatives"] = [
            {
                "name": _safe_string(a.get("name"), 120) or "Alternative",
                "type": _safe_string(a.get("type"), 60) or "artist_direct",
                "url": _safe_string(a.get("url"), 300),
                "note": _safe_string(a.get("note"), 300) or "",
            }
            for a in alternatives[:6]
            if isinstance(a, dict)
        ] or base["alternatives"]

    detail_page = candidate.get("detail_page")
    if isinstance(detail_page, dict):
        base["detail_page"] = {
            "headline": _safe_string(detail_page.get("headline"), 120) or base["detail_page"]["headline"],
            "intro": _safe_string(detail_page.get("intro"), 300) or base["detail_page"]["intro"],
            "cta_label": _safe_string(detail_page.get("cta_label"), 80) or base["detail_page"]["cta_label"],
        }

    estimate_available = bool(base["estimate"].get("available"))
    if not estimate_available:
        base["estimate"]["available"] = False
        base["estimate"]["display_style"] = "none"

    return {key: base[key] for key in ALLOWED_RESULT_KEYS}


def _sanitize_citation(candidate, index):
    if not isinstance(candidate, dict):
        return None
    url = candidate.get("source_url") or candidate.get("url")
    parsed = _parse_http_url(url)
    if not parsed:
        return None
    supports = candidate.get("supports")
    if not isinstance(supports, list):
        supports = []
    return {
        "source_id": _safe_string(candidate.get("source_id"), 40) or f"src_{index}",
        "source_title": _safe_string(candidate.get("source_title") or candidate.get("title"), 180) or parsed.netloc,
        "source_label": _safe_string(candidate.get("source_label"), 180) or parsed.netloc,
        "source_url": urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", "", "")),
        "source_domain": _normalize_hostname(parsed.hostname),
        "source_type": _safe_string(candidate.get("source_type"), 60) or "other",
        "cited_excerpt": _safe_string(candidate.get("cited_excerpt") or candidate.get("cited_text"), 500) or "",
        "supports": [str(item)[:80] for item in supports[:6]],
        "source_verified_at": _safe_string(candidate.get("source_verified_at"), 40) or _now_iso(),
        "source_page_age": _safe_string(candidate.get("source_page_age"), 80),
    }


def _object_to_plain(value):
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, list):
        return [_object_to_plain(item) for item in value]
    if isinstance(value, tuple):
        return [_object_to_plain(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _object_to_plain(item) for key, item in value.items()}
    if hasattr(value, "model_dump"):
        return _object_to_plain(value.model_dump())
    if hasattr(value, "__dict__"):
        return _object_to_plain({key: item for key, item in value.__dict__.items() if not key.startswith("_")})
    return str(value)


def _walk(value):
    if isinstance(value, dict):
        yield value
        for item in value.values():
            yield from _walk(item)
    elif isinstance(value, list):
        for item in value:
            yield from _walk(item)


def _extract_json_from_response(response_plain):
    texts = []
    for node in _walk(response_plain):
        if node.get("type") == "text" and isinstance(node.get("text"), str):
            texts.append(node["text"])
    joined = "\n".join(texts).strip()
    if not joined:
        return {}
    try:
        return json.loads(joined)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", joined, re.S)
        if match:
            try:
                return json.loads(match.group(0))
            except json.JSONDecodeError:
                return {}
    return {}


def _extract_citations(response_plain):
    citations = []
    for node in _walk(response_plain):
        raw_citations = node.get("citations")
        if isinstance(raw_citations, list):
            citations.extend(raw_citations)
        if node.get("type") in {"web_search_result_location", "webpage_location"}:
            citations.append(node)

    sanitized = []
    seen = set()
    for index, citation in enumerate(citations, start=1):
        if not isinstance(citation, dict):
            continue
        candidate = {
            "source_id": f"src_{index}",
            "source_title": citation.get("title") or citation.get("source_title"),
            "source_label": citation.get("title") or citation.get("source_label"),
            "source_url": citation.get("url") or citation.get("source_url"),
            "source_type": "other",
            "cited_excerpt": citation.get("cited_text") or citation.get("text") or citation.get("cited_excerpt"),
            "supports": [],
            "source_page_age": citation.get("page_age") or citation.get("source_page_age"),
        }
        clean = _sanitize_citation(candidate, index)
        if clean and clean["source_url"] not in seen:
            seen.add(clean["source_url"])
            sanitized.append(clean)
    return sanitized


def _extract_tool_errors(response_plain):
    errors = []
    known = {"too_many_requests", "invalid_input", "max_uses_exceeded", "query_too_long", "unavailable"}
    for node in _walk(response_plain):
        if node.get("type") in {"web_search_tool_result", "server_tool_result", "tool_result"}:
            content = node.get("content")
            if isinstance(content, dict):
                code = content.get("error_code") or content.get("code") or content.get("type")
                if code in known:
                    errors.append(code)
            if isinstance(content, str):
                for code in known:
                    if code in content:
                        errors.append(code)
    return sorted(set(errors))


def _normalize_source_url(url):
    parsed = _parse_http_url(url)
    if not parsed:
        return None
    return urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", "", "")).rstrip("/")


def _source_matches_citation(source_value, citation_urls):
    if isinstance(source_value, list):
        return any(_source_matches_citation(item, citation_urls) for item in source_value)
    normalized = _normalize_source_url(source_value)
    return bool(normalized and normalized in citation_urls)


def _validate_cited_claims(result, citations, raw_result=None):
    raw_result = raw_result if isinstance(raw_result, dict) else {}
    citation_urls = {_normalize_source_url(c["source_url"]) for c in citations}
    citation_urls = {url for url in citation_urls if url}
    raw_estimate = raw_result.get("estimate") if isinstance(raw_result.get("estimate"), dict) else {}
    raw_warnings = raw_result.get("warnings") if isinstance(raw_result.get("warnings"), list) else []

    estimate = result.get("estimate", {})
    if estimate.get("available"):
        supported = _source_matches_citation(
            raw_estimate.get("source_url") or raw_estimate.get("source_urls"),
            citation_urls,
        )
        if not supported:
            estimate["available"] = False
            estimate["display_style"] = "none"
            estimate["base_price_range"] = None
            estimate["fee_range"] = None
            estimate["order_fee_range"] = None
            estimate["artist_share_estimate"] = None
            estimate["confidence"] = "low"
            estimate["confidence_score"] = 0
            estimate["explanation"] = "FanCheck did not find a validated citation for a numerical estimate."

    validated_warnings = []
    for index, warning in enumerate(result.get("warnings", [])):
        raw_warning = raw_warnings[index] if index < len(raw_warnings) and isinstance(raw_warnings[index], dict) else {}
        if warning.get("type") in {"resale", "source"} and not _source_matches_citation(
            raw_warning.get("source_url") or raw_warning.get("source_urls"),
            citation_urls,
        ):
            continue
        validated_warnings.append(warning)
    result["warnings"] = validated_warnings
    return result


def _cache_key(payload, parsed):
    signals = payload.get("clientSignals") if isinstance(payload.get("clientSignals"), dict) else {}
    preferences = payload.get("preferences") if isinstance(payload.get("preferences"), dict) else {}
    preflight = payload.get("preflight") if isinstance(payload.get("preflight"), dict) else {}
    parts = [
        _normalize_hostname(parsed.hostname),
        str(signals.get("knownDomain") or ""),
        str(signals.get("purchaseTypeHint") or "unknown"),
        str(_price_bucket(payload)),
        str(preflight.get("version") or ""),
        str(preflight.get("band") or ""),
        str(preferences.get("region") or ""),
    ]
    return "|".join(parts)


def _cache_get(key):
    entry = _analysis_cache.get(key)
    if not entry:
        return None
    if time.time() < entry["expires_at"]:
        return {**entry, "cache_status": "fresh"}
    return {**entry, "cache_status": "stale"}


def _cache_set(key, result, citations):
    _analysis_cache[key] = {
        "result": result,
        "citations": citations,
        "cached_at": _now_iso(),
        "expires_at": time.time() + CACHE_TTL_SECONDS,
    }


def _anthropic_config():
    api_key = os.getenv("ANTHROPIC_API_KEY")
    model = os.getenv("ANTHROPIC_MODEL")
    if not api_key or not model:
        return None, None, jsonify({"error": "ANTHROPIC_API_KEY and ANTHROPIC_MODEL are required for analysis."}), 503
    return api_key, model, None, None


def _parse_small_json(text):
    if not text:
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.S)
        if match:
            try:
                return json.loads(match.group(0))
            except json.JSONDecodeError:
                return {}
    return {}


def _triage_site_report(display_url, hostname, page_title, user_note, local_signals):
    if not _env_bool("FAN_CHECK_SITE_REPORT_TRIAGE_ENABLED", True):
        return {
            "ai_recommendation": "manual_review",
            "ai_confidence": 0,
            "ai_reason": "AI triage is disabled.",
            "ai_category": "unknown",
        }

    api_key = os.getenv("ANTHROPIC_API_KEY")
    model = os.getenv("ANTHROPIC_MODEL")
    if not api_key or not model:
        return {
            "ai_recommendation": "manual_review",
            "ai_confidence": 0,
            "ai_reason": "Anthropic configuration is missing, so this report needs manual review.",
            "ai_category": "unknown",
        }

    try:
        from anthropic import Anthropic
    except ImportError:
        return {
            "ai_recommendation": "manual_review",
            "ai_confidence": 0,
            "ai_reason": "Anthropic SDK is not installed, so this report needs manual review.",
            "ai_category": "unknown",
        }

    prompt = {
        "task": "Triage a user-reported site for FanCheck. Use only this metadata. Do not browse. Do not analyze page text.",
        "url_without_query": display_url,
        "hostname": hostname,
        "page_title": page_title,
        "user_note": user_note,
        "local_signals": local_signals,
        "allowed_recommendations": ["approve_candidate", "reject_candidate", "manual_review"],
        "allowed_categories": ["ticketing", "resale", "merch", "streaming", "venue", "artist_store", "unknown"],
        "response_shape": {
            "recommendation": "approve_candidate | reject_candidate | manual_review",
            "confidence": "integer 0-100",
            "category": "one allowed category",
            "reason": "short reason, no personal data",
        },
    }

    try:
        client = Anthropic(api_key=api_key)
        response = client.messages.create(
            model=model,
            max_tokens=300,
            system=(
                "You triage FanCheck site reports. Recommend whether a URL is a likely "
                "music transaction site candidate. Return JSON only. Never approve final "
                "support automatically; approve_candidate only means worth human review."
            ),
            messages=[{"role": "user", "content": json.dumps(prompt, ensure_ascii=True)}],
        )
    except Exception as exc:
        return {
            "ai_recommendation": "manual_review",
            "ai_confidence": 0,
            "ai_reason": f"AI triage failed: {type(exc).__name__}.",
            "ai_category": "unknown",
        }

    plain = _object_to_plain(response)
    triage = _extract_json_from_response(plain)
    if not triage:
        text = "\n".join(
            node.get("text", "")
            for node in _walk(plain)
            if node.get("type") == "text" and isinstance(node.get("text"), str)
        )
        triage = _parse_small_json(text)

    recommendation = triage.get("recommendation")
    if recommendation not in {"approve_candidate", "reject_candidate", "manual_review"}:
        recommendation = "manual_review"
    category = triage.get("category")
    if category not in {"ticketing", "resale", "merch", "streaming", "venue", "artist_store", "unknown"}:
        category = "unknown"
    try:
        confidence = int(triage.get("confidence", 0))
    except (TypeError, ValueError):
        confidence = 0
    confidence = max(0, min(confidence, 100))
    return {
        "ai_recommendation": recommendation,
        "ai_confidence": confidence,
        "ai_reason": _safe_string(triage.get("reason"), 500) or "No AI triage reason provided.",
        "ai_category": category,
    }


def _anthropic_messages_create(client, **kwargs):
    response = client.messages.create(**kwargs)
    plain = _object_to_plain(response)
    continuations = 0
    messages = kwargs["messages"][:]
    while plain.get("stop_reason") == "pause_turn" and continuations < MAX_CONTINUATIONS:
        messages.append({"role": "assistant", "content": plain.get("content", [])})
        response = client.messages.create(**{**kwargs, "messages": messages})
        plain = _object_to_plain(response)
        continuations += 1
    return plain


def _call_anthropic(payload, parsed):
    api_key, model, error_response, status = _anthropic_config()
    if error_response:
        return None, [], ["missing_config"], error_response, status

    try:
        from anthropic import Anthropic
    except ImportError:
        return None, [], ["anthropic_not_installed"], None, None

    web_search_enabled = _env_bool("ANTHROPIC_WEB_SEARCH_ENABLED", True)
    tool_version = os.getenv("ANTHROPIC_WEB_SEARCH_TOOL_VERSION", "web_search_20260318")
    try:
        max_uses = int(os.getenv("ANTHROPIC_WEB_SEARCH_MAX_USES", "5"))
    except ValueError:
        max_uses = 5

    tools = []
    if web_search_enabled:
        tools.append({"type": tool_version, "name": "web_search", "max_uses": max_uses})

    context = _sanitize_search_context(payload, parsed)
    redacted_text = str(payload.get("redactedText") or "")[:MAX_REDACTED_TEXT_CHARS]
    system_prompt = (
        "You are FanCheck's source-checking analyst. Use web search for current fee, resale, "
        "commission, venue, artist-store, and policy claims. Prefer official platform pages, "
        "regulators, artist or venue official pages, reputable industry organizations, and recent "
        "public sources. Do not make numerical estimates without citation support. Return JSON only."
    )
    user_prompt = {
        "task": "Analyze a consented, redacted music transaction page snippet.",
        "privacy_rules": [
            "Do not use personal/order-specific details in search queries.",
            "Search with platform, artist, venue, region, purchase type, and generic fee terms only.",
            "Do not include raw checkout text, exact basket contents, seat numbers, order IDs, payment details, names, emails, or account info in searches.",
        ],
        "search_context": context,
        "redacted_page_snippet": redacted_text,
        "detected_prices": payload.get("detectedPrices", [])[:MAX_DETECTED_PRICES] if isinstance(payload.get("detectedPrices"), list) else [],
        "response_shape": {
            "summary": {
                "purchase_type": "ticket | merch | streaming | unknown",
                "platform_name": "string or null",
                "detected_total": {"amount": "number or null", "currency": "string or null", "formatted": "string or null"},
            },
            "estimate": {
                "available": "boolean",
                "display_style": "range | qualitative | none",
                "base_price_range": "array of two numbers or null",
                "fee_range": "array of two numbers or null",
                "order_fee_range": "array of two numbers or null",
                "artist_share_estimate": "number or null",
                "confidence": "high | medium | low",
                "confidence_score": "0-100",
                "explanation": "short user-safe explanation",
                "source_url": "URL that supports the numerical estimate, or null",
            },
            "warnings": [{"type": "resale | uncertainty | privacy | source", "severity": "info | warning", "message": "string", "source_url": "URL supporting specific source/resale warnings, or null"}],
            "alternatives": [{"name": "string", "type": "string", "url": "string or null", "note": "string"}],
            "detail_page": {"headline": "string", "intro": "string", "cta_label": "string"},
        },
    }

    client = Anthropic(api_key=api_key)
    kwargs = {
        "model": model,
        "max_tokens": 1600,
        "system": system_prompt,
        "messages": [{"role": "user", "content": json.dumps(user_prompt, ensure_ascii=True)}],
    }
    if tools:
        kwargs["tools"] = tools

    try:
        response_plain = _anthropic_messages_create(client, **kwargs)
    except Exception as exc:
        return None, [], [f"provider_error:{type(exc).__name__}"], None, None

    tool_errors = _extract_tool_errors(response_plain)
    citations = _extract_citations(response_plain)
    result = _extract_json_from_response(response_plain)
    return result, citations, tool_errors, None, None


def _store_analysis(user_id, parsed, result, citations, cache_status):
    analysis_id = secrets.token_urlsafe(18)
    summary = result.get("summary", {})
    detected_total = summary.get("detected_total") if isinstance(summary.get("detected_total"), dict) else {}
    analysis = TransactionAnalysis(
        id=analysis_id,
        user_id=user_id,
        hostname=_normalize_hostname(parsed.hostname),
        page_url_hash=_sha256(_safe_display_url(parsed)),
        platform_name=_safe_string(summary.get("platform_name"), 120),
        purchase_type=_safe_string(summary.get("purchase_type"), 40) or "unknown",
        detected_price=detected_total.get("amount"),
        detected_currency=_safe_string(detected_total.get("currency"), 12),
        result_json=_json_dumps(result),
        citations_json=_json_dumps(citations),
        cache_status=cache_status,
        created_at=_now(),
        expires_at=_now() + timedelta(seconds=CACHE_TTL_SECONDS),
        source_check_status=_safe_string(summary.get("source_check_status"), 20) or "unavailable",
    )
    db.session.add(analysis)
    db.session.commit()
    return analysis


def _analysis_response(analysis, result, citations):
    detail_url = f"{_base_url()}/analysis/{analysis.id}"
    return {
        "analysis_id": analysis.id,
        "detail_url": detail_url,
        "cache_status": analysis.cache_status,
        "source_check_status": analysis.source_check_status,
        "result": result,
        "citations": citations,
    }


@extension_bp.route("/extension/analyze", methods=["POST"])
def analyze_extension_page():
    user_id = _optional_user_id()
    if not _check_rate_limit("analyze", user_id, ANALYZE_LIMIT):
        return _rate_limited()

    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "Invalid JSON body."}), 400

    parsed = _parse_http_url(payload.get("url"))
    if not parsed:
        return jsonify({"error": "A valid http or https url is required."}), 400

    if len(str(payload.get("redactedText") or "")) > MAX_REDACTED_TEXT_CHARS:
        payload["redactedText"] = str(payload.get("redactedText") or "")[:MAX_REDACTED_TEXT_CHARS]
    if isinstance(payload.get("detectedPrices"), list) and len(payload["detectedPrices"]) > MAX_DETECTED_PRICES:
        payload["detectedPrices"] = payload["detectedPrices"][:MAX_DETECTED_PRICES]

    _preflight, gate_error = _validate_analysis_gate(payload)
    if gate_error:
        return gate_error

    cache_key = _cache_key(payload, parsed)
    cached = _cache_get(cache_key)
    if cached and cached["cache_status"] == "fresh":
        result = _sanitize_result(cached["result"], payload, parsed, cached["result"]["summary"].get("source_check_status", "partial"), "fresh")
        citations = [_sanitize_citation(c, i) for i, c in enumerate(cached["citations"], start=1)]
        citations = [c for c in citations if c]
        analysis = _store_analysis(user_id, parsed, result, citations, "fresh")
        return jsonify(_analysis_response(analysis, result, citations))

    raw_result, raw_citations, tool_errors, error_response, status = _call_anthropic(payload, parsed)
    if error_response:
        return error_response, status

    source_status = "verified" if raw_citations and not tool_errors else "partial" if raw_citations else "unavailable"
    if tool_errors and not raw_citations:
        source_status = "unavailable"

    result = _sanitize_result(raw_result, payload, parsed, source_status, "miss")
    citations = [_sanitize_citation(c, i) for i, c in enumerate(raw_citations, start=1)]
    citations = [c for c in citations if c]
    result = _validate_cited_claims(result, citations, raw_result)

    if not raw_result and cached and cached["cache_status"] == "stale":
        result = _sanitize_result(cached["result"], payload, parsed, cached["result"]["summary"].get("source_check_status", "partial"), "stale")
        citations = [_sanitize_citation(c, i) for i, c in enumerate(cached["citations"], start=1)]
        citations = [c for c in citations if c]
        result["warnings"].append({
            "type": "source",
            "severity": "warning",
            "message": "Current source check is unavailable, so FanCheck is showing stale cached guidance.",
        })
        cache_status = "stale"
    else:
        cache_status = "miss"

    if tool_errors and not citations:
        result["summary"]["source_check_status"] = "unavailable"
        result["estimate"]["available"] = False
        result["estimate"]["display_style"] = "none"
        result["estimate"]["explanation"] = "Current source check is unavailable, so FanCheck cannot show a numerical estimate."

    if citations:
        _cache_set(cache_key, result, citations)

    analysis = _store_analysis(user_id, parsed, result, citations, cache_status)
    return jsonify(_analysis_response(analysis, result, citations))


@extension_bp.route("/analysis/<analysis_id>", methods=["GET"])
def analysis_detail(analysis_id):
    analysis = TransactionAnalysis.query.get(analysis_id)
    if not analysis:
        return make_response("Analysis not found", 404)

    result = json.loads(analysis.result_json)
    citations = json.loads(analysis.citations_json)
    summary = result.get("summary", {})
    estimate = result.get("estimate", {})
    detail = result.get("detail_page", {})
    warnings = result.get("warnings", [])
    alternatives = result.get("alternatives", [])
    total = summary.get("detected_total", {})

    def esc(value):
        return html.escape("" if value is None else str(value))

    citation_items = "".join(
        f'<li><a href="{esc(c.get("source_url"))}" target="_blank" rel="noopener">{esc(c.get("source_title"))}</a>'
        f'<p>{esc(c.get("cited_excerpt"))}</p></li>'
        for c in citations
    ) or "<li>No validated source citations were available for this analysis.</li>"
    warning_items = "".join(f"<li>{esc(w.get('message'))}</li>" for w in warnings) or "<li>No warnings.</li>"
    alternative_items = "".join(
        f"<li><strong>{esc(a.get('name'))}</strong>: {esc(a.get('note'))}</li>" for a in alternatives
    ) or "<li>No alternatives available.</li>"

    estimate_text = "No source-backed numerical estimate is available."
    if estimate.get("available"):
        estimate_text = esc(estimate.get("explanation"))

    html_body = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FanCheck analysis</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f8fafc; color: #172033; }}
    main {{ max-width: 860px; margin: 0 auto; padding: 40px 20px; }}
    section {{ background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin: 16px 0; }}
    .pill {{ display: inline-block; border-radius: 999px; padding: 4px 10px; background: #eef2ff; color: #3730a3; font-size: 13px; }}
    a {{ color: #4f46e5; }}
  </style>
</head>
<body>
  <main>
    <p class="pill">FanCheck source detail</p>
    <h1>{esc(detail.get("headline") or "FanCheck analysis")}</h1>
    <p>{esc(detail.get("intro") or "Source-backed transaction context.")}</p>
    <section>
      <h2>Summary</h2>
      <p><strong>Platform:</strong> {esc(summary.get("platform_name"))}</p>
      <p><strong>Hostname:</strong> {esc(summary.get("hostname"))}</p>
      <p><strong>Purchase type:</strong> {esc(summary.get("purchase_type"))}</p>
      <p><strong>Detected total:</strong> {esc(total.get("formatted"))}</p>
      <p><strong>Source status:</strong> {esc(summary.get("source_check_status"))}</p>
      <p><strong>Cache status:</strong> {esc(summary.get("cache_status"))}</p>
    </section>
    <section>
      <h2>Estimate</h2>
      <p>{estimate_text}</p>
      <p><strong>Confidence:</strong> {esc(estimate.get("confidence"))} ({esc(estimate.get("confidence_score"))}/100)</p>
    </section>
    <section>
      <h2>Warnings</h2>
      <ul>{warning_items}</ul>
    </section>
    <section>
      <h2>Fairer alternatives</h2>
      <ul>{alternative_items}</ul>
    </section>
    <section>
      <h2>Sources</h2>
      <ul>{citation_items}</ul>
    </section>
  </main>
</body>
</html>"""
    return html_body


@extension_bp.route("/extension/site-reports", methods=["POST"])
def create_site_report():
    user_id = _optional_user_id()
    if not _check_rate_limit("site_reports", user_id, REPORT_LIMIT):
        return _rate_limited()

    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "Invalid JSON body."}), 400
    parsed = _parse_http_url(payload.get("url"))
    if not parsed:
        return jsonify({"error": "A valid http or https url is required."}), 400

    hostname = _normalize_hostname(payload.get("hostname") or parsed.hostname)
    display_url = _safe_display_url(parsed)
    url_hash = _sha256(f"{hostname}|{parsed.path or '/'}")
    now = _now()
    page_title = _safe_string(payload.get("page_title"), 300)
    user_note = _safe_string(payload.get("user_note"), MAX_REPORT_NOTE_CHARS)
    local_signals = payload.get("local_signals") if isinstance(payload.get("local_signals"), dict) else {}
    triage = _triage_site_report(display_url, hostname, page_title, user_note, local_signals)

    report = SiteReport.query.filter_by(url_hash=url_hash).first()
    if report:
        report.submission_count += 1
        report.last_reported_at = now
        if user_id and not report.user_id:
            report.user_id = user_id
        report.ai_recommendation = triage["ai_recommendation"]
        report.ai_confidence = triage["ai_confidence"]
        report.ai_reason = triage["ai_reason"]
        report.ai_category = triage["ai_category"]
        report.ai_checked_at = now
    else:
        report = SiteReport(
            url_hash=url_hash,
            display_url=display_url,
            hostname=hostname,
            page_title=page_title,
            user_note=user_note,
            local_signals_json=_json_dumps(local_signals),
            user_id=user_id,
            status="pending_review",
            submission_count=1,
            first_reported_at=now,
            last_reported_at=now,
            ai_recommendation=triage["ai_recommendation"],
            ai_confidence=triage["ai_confidence"],
            ai_reason=triage["ai_reason"],
            ai_category=triage["ai_category"],
            ai_checked_at=now,
        )
        db.session.add(report)
    db.session.commit()
    return jsonify({
        "message": "Thanks, we\u2019ll review this site before enabling analysis.",
        "report_id": report.id,
        "status": report.status,
        "submission_count": report.submission_count,
        "ai_recommendation": report.ai_recommendation,
        "ai_confidence": report.ai_confidence,
    }), 201


def _require_demo_admin():
    verify_jwt_in_request()
    user_id = get_jwt_identity()
    if not user_id:
        return None
    # Demo placeholder: any valid JWT is treated as a reviewer. Replace with a real
    # User.is_admin field or role check before exposing this in production.
    return int(user_id)


@extension_bp.route("/extension/site-reports", methods=["GET"])
@jwt_required()
def list_site_reports():
    user_id = _require_demo_admin()
    if not _check_rate_limit("site_reports_admin", user_id, ADMIN_LIMIT):
        return _rate_limited()

    status = request.args.get("status")
    query = SiteReport.query
    if status:
        query = query.filter_by(status=status)
    reports = query.order_by(SiteReport.last_reported_at.desc()).limit(200).all()
    return jsonify({
        "reports": [
            {
                "id": report.id,
                "display_url": report.display_url,
                "hostname": report.hostname,
                "page_title": report.page_title,
                "user_note": report.user_note,
                "local_signals": json.loads(report.local_signals_json or "{}"),
                "status": report.status,
                "submission_count": report.submission_count,
                "first_reported_at": report.first_reported_at.isoformat(),
                "last_reported_at": report.last_reported_at.isoformat(),
                "reviewed_at": report.reviewed_at.isoformat() if report.reviewed_at else None,
                "reviewer_notes": report.reviewer_notes,
                "ai_recommendation": report.ai_recommendation,
                "ai_confidence": report.ai_confidence,
                "ai_reason": report.ai_reason,
                "ai_category": report.ai_category,
                "ai_checked_at": report.ai_checked_at.isoformat() if report.ai_checked_at else None,
            }
            for report in reports
        ]
    })


@extension_bp.route("/extension/site-reports/<int:report_id>", methods=["PATCH"])
@jwt_required()
def update_site_report(report_id):
    reviewer_id = _require_demo_admin()
    if not _check_rate_limit("site_reports_admin", reviewer_id, ADMIN_LIMIT):
        return _rate_limited()

    report = SiteReport.query.get(report_id)
    if not report:
        return jsonify({"error": "Site report not found."}), 404
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "Invalid JSON body."}), 400
    status = payload.get("status")
    if status not in {"pending_review", "approved", "rejected"}:
        return jsonify({"error": "status must be pending_review, approved, or rejected."}), 400
    report.status = status
    report.reviewer_notes = _safe_string(payload.get("reviewer_notes"), 500)
    report.reviewed_at = _now()
    report.reviewed_by_user_id = reviewer_id
    db.session.commit()
    return jsonify({
        "id": report.id,
        "status": report.status,
        "message": "Approved reports are candidates for future host-permission or heuristic updates only.",
    })
