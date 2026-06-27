from extensions import db

class User(db.Model):
    id = db.Column(db.Integer, primary_key = True)
    email = db.Column(db.String(120), unique = True, nullable = False)
    password = db.Column(db.String(20), nullable = False)
    spotify_access_token = db.Column(db.String(500), nullable = True)
    spotify_refresh_token = db.Column(db.String(500), nullable = True)
    spotify_token_expires_at = db.Column(db.DateTime, nullable = True)
