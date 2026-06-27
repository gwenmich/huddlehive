from flask import Flask
from flask_jwt_extended import JWTManager
from flask_cors import CORS
from dotenv import load_dotenv
import os
from extensions import db

load_dotenv()

app = Flask(__name__)
CORS(app)

app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///streamtrue.db"
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

if __name__ == "__main__":
    app.run(debug=True)