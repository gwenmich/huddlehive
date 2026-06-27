from flask import Flask, jsonify, send_from_directory
from flask_jwt_extended import JWTManager
from flask_cors import CORS
from dotenv import load_dotenv
import os
from extensions import db

load_dotenv()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = Flask(__name__)
CORS(app)

app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///fancheck.db"
app.config["JWT_SECRET_KEY"] = os.getenv("JWT_SECRET_KEY")

db.init_app(app)
jwt = JWTManager(app)

with app.app_context():
    import models
    db.create_all()

from routes.auth import auth_bp
from routes.spotify import spotify_bp
from routes.report import report_bp

app.register_blueprint(auth_bp)
app.register_blueprint(spotify_bp)
app.register_blueprint(report_bp)


@app.route("/")
def index():
    return send_from_directory(BASE_DIR, "index.html")


@app.route("/css/<path:filename>")
def styles(filename):
    return send_from_directory(os.path.join(BASE_DIR, "css"), filename)


@app.route("/js/<path:filename>")
def scripts(filename):
    return send_from_directory(os.path.join(BASE_DIR, "js"), filename)


@app.route("/pages/<path:filename>")
def pages(filename):
    return send_from_directory(os.path.join(BASE_DIR, "pages"), filename)


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", 5000)), debug=True)
