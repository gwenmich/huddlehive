from flask import Flask, jsonify, send_from_directory
from flask_jwt_extended import JWTManager
from flask_cors import CORS
from dotenv import load_dotenv
import os
import re
from extensions import db
from sqlalchemy import text

load_dotenv()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = Flask(__name__)


def extension_cors_origins():
    configured = [
        origin.strip()
        for origin in os.getenv("FAN_CHECK_ALLOWED_EXTENSION_ORIGINS", "").split(",")
        if origin.strip()
    ]
    if configured:
        return configured

    return [
        "http://localhost:5000",
        "http://127.0.0.1:5000",
        re.compile(r"^chrome-extension://[a-p]{32}$"),
    ]


CORS(
    app,
    resources={
        r"/extension/*": {
            "origins": extension_cors_origins(),
            "allow_headers": ["Content-Type", "Authorization"],
            "methods": ["GET", "POST", "PATCH", "OPTIONS"],
        },
        r"/auth/login": {
            "origins": extension_cors_origins(),
            "allow_headers": ["Content-Type", "Authorization"],
            "methods": ["POST", "OPTIONS"],
        },
    },
)

app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///fancheck.db"
app.config["JWT_SECRET_KEY"] = os.getenv("JWT_SECRET_KEY")

db.init_app(app)
jwt = JWTManager(app)


def ensure_demo_schema():
    if db.engine.dialect.name != "sqlite":
        return

    site_report_columns = {
        row[1]
        for row in db.session.execute(text("PRAGMA table_info(site_report)")).fetchall()
    }
    for column_name, column_type in {
        "ai_recommendation": "VARCHAR(40)",
        "ai_confidence": "INTEGER",
        "ai_reason": "VARCHAR(500)",
        "ai_category": "VARCHAR(80)",
        "ai_checked_at": "DATETIME",
    }.items():
        if column_name not in site_report_columns:
            db.session.execute(text(f"ALTER TABLE site_report ADD COLUMN {column_name} {column_type}"))
    db.session.commit()

with app.app_context():
    import models
    db.create_all()
    ensure_demo_schema()

from routes.auth import auth_bp
from routes.spotify import spotify_bp
from routes.report import report_bp
from routes.extension import extension_bp

app.register_blueprint(auth_bp)
app.register_blueprint(spotify_bp)
app.register_blueprint(report_bp)
app.register_blueprint(extension_bp)


@app.route("/")
def index():
    return send_from_directory(BASE_DIR, "index.html")


@app.route("/css/<path:filename>")
def styles(filename):
    return send_from_directory(os.path.join(BASE_DIR, "css"), filename)


@app.route("/js/<path:filename>")
def scripts(filename):
    return send_from_directory(os.path.join(BASE_DIR, "js"), filename)


@app.route("/assets/<path:filename>")
def assets(filename):
    return send_from_directory(os.path.join(BASE_DIR, "assets"), filename)


@app.route("/pages/<path:filename>")
def pages(filename):
    return send_from_directory(os.path.join(BASE_DIR, "pages"), filename)


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", 5000)), debug=True)
