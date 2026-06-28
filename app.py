import os
from datetime import timedelta
from flask import Flask, jsonify, redirect, request, send_from_directory
from flask_cors import CORS
from flask_jwt_extended import JWTManager
from dotenv import load_dotenv

from extensions import db

load_dotenv()

app = Flask(__name__)

app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///huddlehive.db"
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", "fancheck-local-secret-change-this")
app.config["JWT_SECRET_KEY"] = os.getenv("JWT_SECRET_KEY", "dev-secret-change-me")
app.config["JWT_TOKEN_LOCATION"] = ["headers", "query_string"]
app.config["JWT_QUERY_STRING_NAME"] = "token"
app.config["JWT_ACCESS_TOKEN_EXPIRES"] = timedelta(hours=12)

CORS(
    app,
    resources={
        r"/*": {
            "origins": ["*"],
            "methods": ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
            "allow_headers": ["Content-Type", "Authorization"],
            "supports_credentials": False,
        }
    },
)

db.init_app(app)
jwt = JWTManager(app)


@app.route("/")
def home():
    return send_from_directory(".", "index.html")


@app.route("/health")
def health_check():
    return jsonify({"status": "ok"}), 200


@app.route("/callback")
@app.route("/auth/callback")
def spotify_callback_alias():
    query = request.query_string.decode()
    target = "/auth/spotify/callback"
    if query:
        target += "?" + query
    return redirect(target)


@app.route("/pages/<path:page>")
def pages(page):
    return send_from_directory("pages", page)


@app.route("/css/<path:filename>")
def css(filename):
    return send_from_directory("css", filename)


@app.route("/js/<path:filename>")
def js(filename):
    return send_from_directory("js", filename)


@app.route("/assets/<path:filename>")
def assets(filename):
    return send_from_directory("assets", filename)


blueprints = [
    ("routes.auth", "auth_bp"),
    ("routes.spotify", "spotify_bp"),
    ("routes.report", "report_bp"),
]

for module_name, blueprint_name in blueprints:
    try:
        module = __import__(module_name, fromlist=[blueprint_name])
        app.register_blueprint(getattr(module, blueprint_name))
        print(f"Registered {module_name}.{blueprint_name}")
    except Exception as e:
        print(f"Warning: could not register {module_name}.{blueprint_name}: {e}")


with app.app_context():
    db.create_all()


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)