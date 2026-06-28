import json
import os
import tempfile
import time
import unittest
from datetime import datetime, timedelta
from unittest.mock import patch

os.environ.setdefault("JWT_SECRET_KEY", "test-secret-key-for-fancheck")
os.environ.setdefault("DATABASE_URL", f"sqlite:///{tempfile.NamedTemporaryFile(suffix='.db', delete=False).name}")
os.environ.setdefault("FAN_CHECK_SITE_REPORT_TRIAGE_ENABLED", "false")
os.environ.setdefault("ANTHROPIC_WEB_SEARCH_ENABLED", "true")
os.environ.setdefault("ANTHROPIC_WEB_SEARCH_TOOL_VERSION", "web_search_20260318")

from flask_jwt_extended import create_access_token

import app as fancheck_app
import data_confidence
import routes.extension as extension
from extensions import db
from models import DataPoint, SiteReport, TransactionAnalysis, User


def analyze_payload(redacted_text="SECRET_ORDER_TOKEN"):
    return {
        "title": "Example checkout",
        "url": "https://ticketmaster.co.uk/event/abc?order=SECRET",
        "redactedText": redacted_text,
        "detectedPrices": [{"amount": 120, "currency": "GBP", "label": "Order total"}],
        "clientSignals": {
            "knownDomain": "ticketmaster.co.uk",
            "purchaseTypeHint": "ticket",
            "pageTypeHint": "checkout",
            "musicKeywords": ["ticket", "concert"],
        },
    }


def cited_result(source_url="https://example.com/source"):
    return {
        "summary": {
            "purchase_type": "ticket",
            "platform_name": "Ticketmaster",
            "detected_total": {"amount": 120, "currency": "GBP", "formatted": "£120.00"},
        },
        "estimate": {
            "available": True,
            "display_style": "range",
            "fee_range": [10, 20],
            "confidence": "high",
            "confidence_score": 90,
            "explanation": "Source-backed estimate.",
            "source_url": source_url,
        },
        "warnings": [],
        "alternatives": [],
        "detail_page": {"headline": "FanCheck detail", "intro": "Safe detail", "cta_label": "Open"},
    }


def citation(url="https://example.com/source"):
    return [{
        "source_title": "Example Source",
        "source_label": "Example",
        "source_url": url,
        "source_domain": "example.com",
        "source_type": "official",
        "cited_excerpt": "Public fee source.",
        "supports": ["estimate"],
        "source_verified_at": "2026-06-28T00:00:00Z",
        "source_page_age": "current",
    }]


class BackendPrivacyTests(unittest.TestCase):
    def setUp(self):
        fancheck_app.app.config["TESTING"] = True
        self.client = fancheck_app.app.test_client()
        with fancheck_app.app.app_context():
            db.drop_all()
            db.create_all()
        extension._analysis_cache.clear()
        extension._rate_limits.clear()
        os.environ["FAN_CHECK_SITE_REPORT_TRIAGE_ENABLED"] = "false"
        os.environ["ANTHROPIC_API_KEY"] = "test-key"
        os.environ["ANTHROPIC_MODEL"] = "test-model"

    def token(self):
        with fancheck_app.app.app_context():
            db.session.add(User(email="admin@example.com", password="x"))
            db.session.commit()
            return create_access_token(identity="1")

    def test_analyze_missing_config_returns_503(self):
        os.environ.pop("ANTHROPIC_API_KEY", None)
        os.environ.pop("ANTHROPIC_MODEL", None)
        response = self.client.post("/extension/analyze", json=analyze_payload())
        self.assertEqual(response.status_code, 503)
        self.assertIn("ANTHROPIC_API_KEY", response.get_json()["error"])

    def test_auth_register_allows_extension_cors(self):
        response = self.client.options(
            "/auth/register",
            headers={
                "Origin": "chrome-extension://oldelpnmpmohnlpaaimcpemgjembecje",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "Content-Type",
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.headers.get("Access-Control-Allow-Origin"),
            "chrome-extension://oldelpnmpmohnlpaaimcpemgjembecje",
        )

    def test_citation_mismatch_omits_estimate(self):
        with patch.object(extension, "_call_anthropic", return_value=(cited_result("https://bad.example/source"), citation(), [], None, None)):
            response = self.client.post("/extension/analyze", json=analyze_payload())
        self.assertEqual(response.status_code, 200)
        estimate = response.get_json()["result"]["estimate"]
        self.assertFalse(estimate["available"])
        self.assertEqual(estimate["display_style"], "none")

    def test_web_search_errors_fallback_without_crash(self):
        with patch.object(extension, "_call_anthropic", return_value=(None, [], ["too_many_requests"], None, None)):
            response = self.client.post("/extension/analyze", json=analyze_payload())
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(body["source_check_status"], "unavailable")
        self.assertFalse(body["result"]["estimate"]["available"])

    def test_daily_cache_miss_fresh_and_stale(self):
        calls = [
            (cited_result(), citation(), [], None, None),
            (None, [], ["unavailable"], None, None),
        ]

        def fake_call(*_args):
            return calls.pop(0)

        with patch.object(extension, "_call_anthropic", side_effect=fake_call) as mocked:
            first = self.client.post("/extension/analyze", json=analyze_payload("FIRST"))
            second = self.client.post("/extension/analyze", json=analyze_payload("SECOND"))
            for entry in extension._analysis_cache.values():
                entry["expires_at"] = time.time() - 1
            third = self.client.post("/extension/analyze", json=analyze_payload("THIRD"))

        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.get_json()["cache_status"], "miss")
        self.assertEqual(second.get_json()["cache_status"], "fresh")
        self.assertEqual(third.get_json()["cache_status"], "stale")
        self.assertEqual(mocked.call_count, 2)

    def test_raw_snippets_are_not_stored(self):
        secret = "VERY_SECRET_REDACTED_SNIPPET"
        with patch.object(extension, "_call_anthropic", return_value=(cited_result(), citation(), [], None, None)):
            response = self.client.post("/extension/analyze", json=analyze_payload(secret))
        self.assertEqual(response.status_code, 200)
        with fancheck_app.app.app_context():
            stored = TransactionAnalysis.query.first()
            serialized = json.dumps({
                "result": json.loads(stored.result_json),
                "citations": json.loads(stored.citations_json),
                "page_url_hash": stored.page_url_hash,
            })
        self.assertNotIn(secret, serialized)
        self.assertNotIn("order=SECRET", serialized)

    def test_result_and_citations_contain_only_allowed_fields(self):
        with patch.object(extension, "_call_anthropic", return_value=(cited_result(), citation(), [], None, None)):
            response = self.client.post("/extension/analyze", json=analyze_payload())
        self.assertEqual(response.status_code, 200)
        with fancheck_app.app.app_context():
            stored = TransactionAnalysis.query.first()
            result = json.loads(stored.result_json)
            citations = json.loads(stored.citations_json)
        self.assertLessEqual(set(result.keys()), extension.ALLOWED_RESULT_KEYS)
        for item in citations:
            self.assertLessEqual(set(item.keys()), extension.ALLOWED_CITATION_KEYS)

    def test_analysis_detail_renders_non_sensitive_page(self):
        with patch.object(extension, "_call_anthropic", return_value=(cited_result(), citation(), [], None, None)):
            response = self.client.post("/extension/analyze", json=analyze_payload("PRIVATE_SNIPPET"))
        analysis_id = response.get_json()["analysis_id"]
        detail = self.client.get(f"/analysis/{analysis_id}")
        body = detail.get_data(as_text=True)
        self.assertEqual(detail.status_code, 200)
        self.assertIn("FanCheck source detail", body)
        self.assertNotIn("PRIVATE_SNIPPET", body)
        self.assertNotIn("order=SECRET", body)

    def test_site_report_validates_url(self):
        response = self.client.post("/extension/site-reports", json={"url": "javascript:alert(1)"})
        self.assertEqual(response.status_code, 400)

    def test_site_report_dedupe_increments_count_and_pending_status(self):
        payload = {
            "url": "https://example.com/tickets?session=abc",
            "hostname": "example.com",
            "page_title": "Tickets",
            "user_note": "Looks like tickets",
            "local_signals": {"ticketWords": 1},
        }
        first = self.client.post("/extension/site-reports", json=payload)
        second = self.client.post("/extension/site-reports", json=payload)
        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 201)
        self.assertEqual(second.get_json()["submission_count"], 2)
        self.assertEqual(second.get_json()["status"], "pending_review")
        with fancheck_app.app.app_context():
            self.assertEqual(SiteReport.query.count(), 1)
            report = SiteReport.query.first()
            self.assertEqual(report.display_url, "https://example.com/tickets")

    def test_site_report_rate_limiting(self):
        statuses = []
        for index in range(extension.REPORT_LIMIT + 1):
            statuses.append(self.client.post("/extension/site-reports", json={
                "url": f"https://example.com/tickets/{index}",
                "hostname": "example.com",
            }).status_code)
        self.assertEqual(statuses[-1], 429)

    def test_site_report_patch_status_with_admin_placeholder(self):
        created = self.client.post("/extension/site-reports", json={
            "url": "https://example.com/tickets",
            "hostname": "example.com",
        })
        token = self.token()
        response = self.client.patch(
            f"/extension/site-reports/{created.get_json()['report_id']}",
            json={"status": "approved", "reviewer_notes": "candidate"},
            headers={"Authorization": f"Bearer {token}"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["status"], "approved")
        self.assertIn("candidates", response.get_json()["message"])

    def test_data_point_scoring_bands(self):
        research = {
            "key": "venue_merch_commission",
            "label": "Venue merch commission",
            "figure_low": 10,
            "figure_high": 20,
            "figure_point": None,
            "unit": "percent",
            "currency": None,
            "has_core_citation": True,
            "methodology_notes": "This methodology note is intentionally long enough to show transparent derivation from cited public sources.",
            "contradictions": None,
            "outside_expected_range": False,
            "sources": [
                {"source_type": "official", "source_label": "Official A", "source_domain": "a.example", "publication_date": str(datetime.now().year), "supports": ["core_figure", "methodology"]},
                {"source_type": "industry_report", "source_label": "Report B", "source_domain": "b.example", "publication_date": str(datetime.now().year), "supports": ["core_figure"]},
                {"source_type": "news", "source_label": "News C", "source_domain": "c.example", "publication_date": str(datetime.now().year), "supports": ["core_figure"]},
            ],
        }
        scored = data_confidence.score_data_point(research)
        self.assertEqual(scored["confidence_band"], "HIGH")
        self.assertGreaterEqual(scored["confidence_score"], 80)

    def test_data_point_stale_after_one_day(self):
        with fancheck_app.app.app_context():
            record = DataPoint(
                key="venue_merch_commission",
                label="Venue merch commission",
                confidence_score=80,
                confidence_band="HIGH",
                sources_json="[]",
                dimension_scores_json="{}",
                dimension_evidence_json="{}",
                display_json="{}",
                last_updated=datetime.now() - timedelta(days=2),
            )
            db.session.add(record)
            db.session.commit()
            self.assertIsNone(data_confidence.get_data_point("venue_merch_commission"))
            self.assertIsNotNone(data_confidence.get_any_data_point("venue_merch_commission"))

    def test_missing_citation_makes_data_point_insufficient(self):
        research = data_confidence._sanitize_research_result(
            {
                "key": "spotify_per_stream_rate",
                "label": "Spotify per-stream payout estimate",
                "unit": "per_stream",
                "currency": "USD",
            },
            {
                "figure_low": 0.003,
                "figure_high": 0.005,
                "sources": [{"source_url": "https://uncited.example/source", "supports": ["core_figure"]}],
                "methodology_notes": "Uncited claim.",
            },
            [],
            set(),
            [],
        )
        scored = data_confidence.score_data_point(research)
        self.assertFalse(research["has_core_citation"])
        self.assertIsNone(research["figure_low"])
        self.assertEqual(scored["confidence_band"], "INSUFFICIENT")


if __name__ == "__main__":
    unittest.main()
