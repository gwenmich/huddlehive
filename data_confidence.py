import asyncio
import json
import logging
import os
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse, urlunparse

from extensions import db
from models import DataPoint

logger = logging.getLogger(__name__)

FRESHNESS_DAYS = 1
MAX_CONTINUATIONS = 2

RUBRIC_DIMENSIONS = [
    "Source Authority",
    "Recency",
    "Corroboration",
    "Specificity",
    "Methodology Transparency",
]

DATA_POINTS = [
    {
        "key": "spotify_per_stream_rate",
        "label": "Spotify per-stream payout estimate",
        "unit": "per_stream",
        "currency": "USD",
        "expected_low": 0.001,
        "expected_high": 0.01,
        "search_terms": ["Spotify per stream payout rate current artist royalties"],
    },
    {
        "key": "apple_music_per_stream_rate",
        "label": "Apple Music per-stream payout estimate",
        "unit": "per_stream",
        "currency": "USD",
        "expected_low": 0.003,
        "expected_high": 0.02,
        "search_terms": ["Apple Music per stream payout rate current artist royalties"],
    },
    {
        "key": "tidal_per_stream_rate",
        "label": "Tidal per-stream payout estimate",
        "unit": "per_stream",
        "currency": "USD",
        "expected_low": 0.003,
        "expected_high": 0.03,
        "search_terms": ["Tidal per stream payout rate current artist royalties"],
    },
    {
        "key": "youtube_music_per_stream_rate",
        "label": "YouTube Music per-stream payout estimate",
        "unit": "per_stream",
        "currency": "USD",
        "expected_low": 0.0001,
        "expected_high": 0.008,
        "search_terms": ["YouTube Music per stream payout rate current artist royalties"],
    },
    {
        "key": "bandcamp_artist_revenue_pct",
        "label": "Bandcamp artist revenue share",
        "unit": "percent",
        "currency": None,
        "expected_low": 70,
        "expected_high": 95,
        "search_terms": ["Bandcamp revenue share artist percentage fees current"],
    },
    {
        "key": "ticketmaster_booking_fee_pct",
        "label": "Ticketmaster booking or service fee range",
        "unit": "percent",
        "currency": None,
        "expected_low": 0,
        "expected_high": 60,
        "search_terms": ["Ticketmaster booking fee service fee percentage range current"],
    },
    {
        "key": "secondary_market_average_markup",
        "label": "Secondary ticket market average markup",
        "unit": "percent",
        "currency": None,
        "expected_low": 0,
        "expected_high": 300,
        "search_terms": ["secondary ticket market average markup percentage current public report"],
    },
    {
        "key": "major_label_artist_royalty_rate",
        "label": "Major label artist royalty rate",
        "unit": "percent",
        "currency": None,
        "expected_low": 5,
        "expected_high": 35,
        "search_terms": ["major label artist royalty rate percentage public source"],
    },
    {
        "key": "venue_merch_commission",
        "label": "Venue merch commission",
        "unit": "percent",
        "currency": None,
        "expected_low": 0,
        "expected_high": 50,
        "search_terms": ["venue merch commission percentage artist merchandise current"],
    },
    {
        "key": "spotify_algorithm_editorial_share",
        "label": "Spotify algorithmic/editorial listening share",
        "unit": "percent",
        "currency": None,
        "expected_low": 0,
        "expected_high": 80,
        "search_terms": ["Spotify algorithmic editorial playlist listening share percentage public source"],
    },
]


def _now():
    return datetime.now(timezone.utc)


def _now_iso():
    return _now().isoformat().replace("+00:00", "Z")


def _json_dumps(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True)


def _json_loads(value, default):
    try:
        return json.loads(value or "")
    except (TypeError, json.JSONDecodeError):
        return default


def _safe_string(value, max_len=500):
    if value is None:
        return None
    return str(value).strip()[:max_len]


def _parse_http_url(url):
    parsed = urlparse((url or "").strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    return parsed


def _safe_source_url(url):
    parsed = _parse_http_url(url)
    if not parsed:
        return None
    return urlunparse((parsed.scheme, parsed.netloc, parsed.path or "/", "", "", "")).rstrip("/")


def _source_domain(url):
    parsed = _parse_http_url(url)
    if not parsed:
        return None
    hostname = (parsed.hostname or "").lower()
    return hostname[4:] if hostname.startswith("www.") else hostname


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
        if isinstance(node, dict) and node.get("type") == "text" and isinstance(node.get("text"), str):
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
    raw = []
    for node in _walk(response_plain):
        if not isinstance(node, dict):
            continue
        citations = node.get("citations")
        if isinstance(citations, list):
            raw.extend(citations)
        if node.get("type") in {"web_search_result_location", "webpage_location"}:
            raw.append(node)

    sanitized = []
    seen = set()
    for citation in raw:
        if not isinstance(citation, dict):
            continue
        url = _safe_source_url(citation.get("url") or citation.get("source_url"))
        if not url or url in seen:
            continue
        seen.add(url)
        sanitized.append({
            "source_title": _safe_string(citation.get("title") or citation.get("source_title"), 180) or _source_domain(url),
            "source_url": url,
            "source_label": _safe_string(citation.get("title") or citation.get("source_label"), 180) or _source_domain(url),
            "source_domain": _source_domain(url),
            "source_type": "other",
            "figure_reported": None,
            "publication_date": _safe_string(citation.get("publication_date"), 40),
            "cited_excerpt": _safe_string(citation.get("cited_text") or citation.get("text") or citation.get("cited_excerpt"), 500) or "",
            "source_verified_at": _now_iso(),
            "supports": [],
        })
    return sanitized


def _extract_tool_errors(response_plain):
    errors = []
    known = {"too_many_requests", "invalid_input", "max_uses_exceeded", "query_too_long", "unavailable"}
    for node in _walk(response_plain):
        if not isinstance(node, dict):
            continue
        if node.get("type") in {"web_search_tool_result", "server_tool_result", "tool_result"}:
            content = node.get("content")
            if isinstance(content, dict):
                code = content.get("error_code") or content.get("code") or content.get("type")
                if code in known:
                    errors.append(code)
            if isinstance(content, str):
                errors.extend([code for code in known if code in content])
    return sorted(set(errors))


def _env_bool(name, default):
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


async def _anthropic_messages_create(client, **kwargs):
    response = await client.messages.create(**kwargs)
    plain = _object_to_plain(response)
    continuations = 0
    messages = kwargs["messages"][:]
    while plain.get("stop_reason") == "pause_turn" and continuations < MAX_CONTINUATIONS:
        messages.append({"role": "assistant", "content": plain.get("content", [])})
        response = await client.messages.create(**{**kwargs, "messages": messages})
        plain = _object_to_plain(response)
        continuations += 1
    return plain


def _empty_research_result(data_point, reason):
    return {
        "key": data_point["key"],
        "label": data_point["label"],
        "figure_low": None,
        "figure_high": None,
        "figure_point": None,
        "unit": data_point.get("unit"),
        "currency": data_point.get("currency"),
        "sources": [],
        "methodology_notes": reason,
        "contradictions": None,
        "outside_expected_range": False,
        "tool_errors": [],
        "has_core_citation": False,
    }


async def research_data_point(data_point):
    api_key = os.getenv("ANTHROPIC_API_KEY")
    model = os.getenv("ANTHROPIC_MODEL")
    web_search_enabled = _env_bool("ANTHROPIC_WEB_SEARCH_ENABLED", True)
    tool_version = os.getenv("ANTHROPIC_WEB_SEARCH_TOOL_VERSION")
    try:
        max_uses = int(os.getenv("ANTHROPIC_WEB_SEARCH_MAX_USES", "5"))
    except ValueError:
        max_uses = 5

    if not api_key or not model:
        return _empty_research_result(data_point, "ANTHROPIC_API_KEY and ANTHROPIC_MODEL are required.")
    if not web_search_enabled:
        return _empty_research_result(data_point, "Anthropic Web Search is disabled.")
    if not tool_version:
        return _empty_research_result(data_point, "ANTHROPIC_WEB_SEARCH_TOOL_VERSION is required.")

    try:
        from anthropic import AsyncAnthropic
    except ImportError:
        return _empty_research_result(data_point, "Anthropic SDK is not installed.")

    tools = [{"type": tool_version, "name": "web_search", "max_uses": max_uses}]
    prompt = {
        "task": "Research one recurring global music-industry data point for FanCheck.",
        "data_point": {
            "key": data_point["key"],
            "label": data_point["label"],
            "unit": data_point.get("unit"),
            "currency": data_point.get("currency"),
            "expected_low": data_point.get("expected_low"),
            "expected_high": data_point.get("expected_high"),
            "search_terms": data_point.get("search_terms", []),
        },
        "privacy_rules": [
            "This is global industry research only.",
            "Do not include user page text, user URLs, order IDs, seat details, payment info, account info, or transaction context.",
        ],
        "source_requirements": [
            "Use current public sources and include publication dates when available.",
            "Prefer official platform pages, public filings, regulator or government pages, artist/venue statements, and reputable industry research.",
            "Avoid unsupported numerical claims.",
            "Every numerical figure must include source_url values that correspond to actual Web Search citation blocks.",
        ],
        "response_shape": {
            "figure_low": "number or null",
            "figure_high": "number or null",
            "figure_point": "number or null",
            "unit": data_point.get("unit"),
            "currency": data_point.get("currency"),
            "sources": [{
                "source_title": "string",
                "source_url": "cited URL",
                "source_label": "short label",
                "source_type": "official | regulator | filing | industry_report | news | academic | other",
                "figure_reported": "short safe string",
                "publication_date": "YYYY-MM-DD or year or null",
                "supports": ["core_figure", "methodology", "contradiction"],
            }],
            "methodology_notes": "short notes on how the figure was derived",
            "contradictions": "short notes or null",
            "outside_expected_range": "boolean",
        },
    }

    try:
        client = AsyncAnthropic(api_key=api_key)
        try:
            timeout_seconds = int(os.getenv("FAN_CHECK_DATA_CONFIDENCE_TIMEOUT_SECONDS", "45"))
        except ValueError:
            timeout_seconds = 45
        response_plain = await asyncio.wait_for(
            _anthropic_messages_create(
                client,
                model=model,
                max_tokens=1800,
                system=(
                    "You are FanCheck's global music-industry data researcher. Use Web Search. "
                    "Return JSON only. Do not include hidden reasoning. Do not invent source URLs."
                ),
                messages=[{"role": "user", "content": json.dumps(prompt, ensure_ascii=True)}],
                tools=tools,
            ),
            timeout=max(5, timeout_seconds),
        )
    except Exception as exc:
        logger.exception("Data point research failed for %s", data_point.get("key"))
        result = _empty_research_result(data_point, f"Anthropic research failed: {type(exc).__name__}.")
        result["tool_errors"] = [type(exc).__name__]
        return result

    citations = _extract_citations(response_plain)
    citation_urls = {source["source_url"] for source in citations}
    raw_result = _extract_json_from_response(response_plain)
    tool_errors = _extract_tool_errors(response_plain)
    return _sanitize_research_result(data_point, raw_result, citations, citation_urls, tool_errors)


def _number_or_none(value):
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _sanitize_research_result(data_point, raw_result, citations, citation_urls, tool_errors):
    if not isinstance(raw_result, dict):
        raw_result = {}

    sources_by_url = {source["source_url"]: source for source in citations}
    safe_sources = []
    for source in raw_result.get("sources", []) if isinstance(raw_result.get("sources"), list) else []:
        if not isinstance(source, dict):
            continue
        url = _safe_source_url(source.get("source_url"))
        if not url or url not in citation_urls:
            continue
        citation = sources_by_url[url]
        supports = source.get("supports") if isinstance(source.get("supports"), list) else []
        safe_sources.append({
            "source_title": _safe_string(source.get("source_title") or citation.get("source_title"), 180) or citation["source_title"],
            "source_url": url,
            "source_label": _safe_string(source.get("source_label"), 120) or citation["source_label"],
            "source_domain": _source_domain(url),
            "source_type": _safe_string(source.get("source_type"), 40) or "other",
            "figure_reported": _safe_string(source.get("figure_reported"), 160),
            "publication_date": _safe_string(source.get("publication_date") or citation.get("publication_date"), 40),
            "cited_excerpt": citation.get("cited_excerpt") or "",
            "source_verified_at": _now_iso(),
            "supports": [str(item)[:80] for item in supports[:6]],
        })

    has_core_citation = any("core_figure" in source.get("supports", []) for source in safe_sources)
    figure_low = _number_or_none(raw_result.get("figure_low"))
    figure_high = _number_or_none(raw_result.get("figure_high"))
    figure_point = _number_or_none(raw_result.get("figure_point"))

    if not has_core_citation:
        figure_low = None
        figure_high = None
        figure_point = None

    expected_low = _number_or_none(data_point.get("expected_low"))
    expected_high = _number_or_none(data_point.get("expected_high"))
    observed = [value for value in [figure_low, figure_high, figure_point] if value is not None]
    outside_expected_range = bool(
        observed
        and expected_low is not None
        and expected_high is not None
        and (min(observed) < expected_low or max(observed) > expected_high)
    )

    return {
        "key": data_point["key"],
        "label": data_point["label"],
        "figure_low": figure_low,
        "figure_high": figure_high,
        "figure_point": figure_point,
        "unit": _safe_string(raw_result.get("unit"), 40) or data_point.get("unit"),
        "currency": _safe_string(raw_result.get("currency"), 12) or data_point.get("currency"),
        "sources": safe_sources[:8],
        "methodology_notes": _safe_string(raw_result.get("methodology_notes"), 1000) or "No methodology notes available.",
        "contradictions": _safe_string(raw_result.get("contradictions"), 1000),
        "outside_expected_range": outside_expected_range,
        "tool_errors": tool_errors,
        "has_core_citation": has_core_citation,
    }


def _source_authority_score(sources):
    if not sources:
        return 0, "No validated sources."
    weights = {
        "official": 20,
        "regulator": 20,
        "filing": 18,
        "academic": 17,
        "industry_report": 15,
        "news": 10,
        "other": 7,
    }
    score = max(weights.get((source.get("source_type") or "other").lower(), 7) for source in sources)
    evidence = ", ".join(source.get("source_label") or source.get("source_domain") or "source" for source in sources[:3])
    return min(20, score), f"Best validated source authority from: {evidence}."


def _recency_score(sources):
    if not sources:
        return 0, "No source dates available."
    current_year = _now().year
    years = []
    for source in sources:
        match = re.search(r"(20\d{2}|19\d{2})", str(source.get("publication_date") or ""))
        if match:
            years.append(int(match.group(1)))
    if not years:
        return 8, "Validated sources exist, but publication dates were not clear."
    newest = max(years)
    age = current_year - newest
    if age <= 1:
        score = 20
    elif age <= 3:
        score = 16
    elif age <= 5:
        score = 12
    else:
        score = 6
    return score, f"Newest cited publication year found: {newest}."


def _corroboration_score(sources):
    core_sources = [source for source in sources if "core_figure" in source.get("supports", [])]
    domains = {source.get("source_domain") for source in core_sources if source.get("source_domain")}
    if len(domains) >= 3:
        return 20, f"Core figure is supported by {len(domains)} distinct cited domains."
    if len(domains) == 2:
        return 15, "Core figure is supported by two distinct cited domains."
    if len(domains) == 1:
        return 9, "Core figure has one validated cited domain."
    return 0, "Core figure has no validated citation support."


def _specificity_score(research):
    if not research.get("has_core_citation"):
        return 0, "No cited core figure."
    has_number = any(research.get(key) is not None for key in ["figure_low", "figure_high", "figure_point"])
    if has_number and research.get("unit"):
        return 20, f"Figure is numeric and uses unit: {research.get('unit')}."
    if has_number:
        return 12, "Figure is numeric, but unit is unclear."
    return 4, "Sources are relevant, but no precise numeric figure was retained."


def _methodology_score(research):
    notes = research.get("methodology_notes") or ""
    sources = research.get("sources") or []
    methodology_sources = [source for source in sources if "methodology" in source.get("supports", [])]
    if methodology_sources and len(notes) > 80:
        return 20, "Methodology notes are present and source-supported."
    if len(notes) > 80:
        return 14, "Methodology notes are present but lightly sourced."
    if notes and notes != "No methodology notes available.":
        return 8, "Methodology notes are brief."
    return 0, "No useful methodology notes."


def _band(score):
    if score >= 80:
        return "HIGH"
    if score >= 60:
        return "MEDIUM"
    if score >= 40:
        return "LOW"
    return "INSUFFICIENT"


def score_data_point(research):
    sources = research.get("sources") or []
    dimension_scores = {}
    dimension_evidence = {}

    scoring = {
        "Source Authority": _source_authority_score(sources),
        "Recency": _recency_score(sources),
        "Corroboration": _corroboration_score(sources),
        "Specificity": _specificity_score(research),
        "Methodology Transparency": _methodology_score(research),
    }
    for dimension, (score, evidence) in scoring.items():
        dimension_scores[dimension] = int(max(0, min(20, score)))
        dimension_evidence[dimension] = evidence

    if not research.get("has_core_citation"):
        total = 0
        band = "INSUFFICIENT"
        label = "Insufficient citation support"
    else:
        total = sum(dimension_scores.values())
        band = _band(total)
        label = f"{band.title()} confidence"

    display = _display_object(research, total, band, label)
    return {
        "confidence_score": total,
        "confidence_band": band,
        "label": label,
        "display": display,
        "dimension_scores": dimension_scores,
        "dimension_evidence": dimension_evidence,
    }


def _format_figure(research):
    unit = research.get("unit")
    currency = research.get("currency")
    low = research.get("figure_low")
    high = research.get("figure_high")
    point = research.get("figure_point")
    suffix = "%" if unit == "percent" else ""
    prefix = "$" if currency == "USD" else ""
    if point is not None:
        return f"{prefix}{point:g}{suffix}"
    if low is not None and high is not None:
        return f"{prefix}{low:g}{suffix}-{prefix}{high:g}{suffix}"
    if low is not None:
        return f"{prefix}{low:g}{suffix}+"
    if high is not None:
        return f"Up to {prefix}{high:g}{suffix}"
    return "Insufficient source-backed data"


def _display_object(research, score, band, label):
    return {
        "key": research["key"],
        "label": research["label"],
        "primary_figure": _format_figure(research),
        "unit": research.get("unit"),
        "currency": research.get("currency"),
        "confidence_score": score,
        "confidence_band": band,
        "confidence_label": label,
        "methodology_summary": research.get("methodology_notes"),
        "has_contradictions": bool(research.get("contradictions")),
        "outside_expected_range": bool(research.get("outside_expected_range")),
        "source_count": len(research.get("sources") or []),
        "last_updated": _now_iso(),
    }


def _data_point_to_dict(record):
    return {
        "key": record.key,
        "label": record.label,
        "figure_low": record.figure_low,
        "figure_high": record.figure_high,
        "figure_point": record.figure_point,
        "unit": record.unit,
        "currency": record.currency,
        "confidence_score": record.confidence_score,
        "confidence_band": record.confidence_band,
        "sources": _json_loads(record.sources_json, []),
        "methodology_notes": record.methodology_notes,
        "contradictions": record.contradictions,
        "dimension_scores": _json_loads(record.dimension_scores_json, {}),
        "dimension_evidence": _json_loads(record.dimension_evidence_json, {}),
        "last_updated": record.last_updated.isoformat() if record.last_updated else None,
        "display": _json_loads(record.display_json, {}),
    }


def data_point_to_dict(record):
    return _data_point_to_dict(record)


def safe_default_for_data_point(data_point):
    research = _empty_research_result(data_point, "This data point has not been refreshed yet.")
    scored = score_data_point(research)
    return {
        "key": research["key"],
        "label": research["label"],
        "figure_low": None,
        "figure_high": None,
        "figure_point": None,
        "unit": research.get("unit"),
        "currency": research.get("currency"),
        "confidence_score": scored["confidence_score"],
        "confidence_band": scored["confidence_band"],
        "sources": [],
        "methodology_notes": research["methodology_notes"],
        "contradictions": None,
        "dimension_scores": scored["dimension_scores"],
        "dimension_evidence": scored["dimension_evidence"],
        "last_updated": None,
        "display": scored["display"],
    }


def get_data_point(key, max_age_days=FRESHNESS_DAYS):
    record = DataPoint.query.get(key)
    if not record:
        return None
    cutoff = datetime.now() - timedelta(days=max_age_days)
    if record.last_updated < cutoff:
        return None
    return record


def get_any_data_point(key):
    return DataPoint.query.get(key)


def list_data_points(include_stale=True):
    records = DataPoint.query.order_by(DataPoint.key.asc()).all()
    if include_stale:
        return records
    return [record for record in records if get_data_point(record.key)]


def _upsert_data_point(research, scored):
    now = datetime.now()
    record = DataPoint.query.get(research["key"])
    if not record:
        record = DataPoint(key=research["key"])
        db.session.add(record)

    record.label = research["label"]
    record.figure_low = research.get("figure_low")
    record.figure_high = research.get("figure_high")
    record.figure_point = research.get("figure_point")
    record.unit = research.get("unit")
    record.currency = research.get("currency")
    record.confidence_score = scored["confidence_score"]
    record.confidence_band = scored["confidence_band"]
    record.sources_json = _json_dumps(research.get("sources") or [])
    record.methodology_notes = research.get("methodology_notes")
    record.contradictions = research.get("contradictions")
    record.dimension_scores_json = _json_dumps(scored["dimension_scores"])
    record.dimension_evidence_json = _json_dumps(scored["dimension_evidence"])
    record.last_updated = now
    record.display_json = _json_dumps(scored["display"])
    db.session.commit()
    return record


async def refresh_data_point(data_point):
    try:
        research = await research_data_point(data_point)
        existing = DataPoint.query.get(data_point["key"])
        if not research.get("has_core_citation") and existing:
            return existing, "refresh_failed_using_stale"
        scored = score_data_point(research)
        status = "refreshed" if research.get("has_core_citation") else "refreshed_insufficient"
        return _upsert_data_point(research, scored), status
    except Exception:
        logger.exception("Could not refresh data point %s", data_point.get("key"))
        db.session.rollback()
        existing = DataPoint.query.get(data_point["key"])
        if existing:
            return existing, "refresh_failed_using_stale"
        fallback = _empty_research_result(data_point, "Refresh failed; safe display defaults are shown.")
        scored = score_data_point(fallback)
        return _upsert_data_point(fallback, scored), "refreshed_insufficient"


async def refresh_all_data_points(max_age_days=FRESHNESS_DAYS, keys=None, limit=None):
    selected_keys = set(keys or [])
    results = []
    first_call = True
    refresh_count = 0
    for data_point in DATA_POINTS:
        if selected_keys and data_point["key"] not in selected_keys:
            continue
        if get_data_point(data_point["key"], max_age_days=max_age_days):
            results.append({"key": data_point["key"], "status": "fresh"})
            continue
        if limit is not None and refresh_count >= limit:
            results.append({"key": data_point["key"], "status": "skipped_limit"})
            continue
        if not first_call:
            await asyncio.sleep(2)
        first_call = False
        record, status = await refresh_data_point(data_point)
        refresh_count += 1
        results.append({
            "key": record.key,
            "status": status,
            "confidence_band": record.confidence_band,
            "confidence_score": record.confidence_score,
        })
    return results
