"""Google Health API client: OAuth and paged data point reads.

Login: one consent with access_type=offline and prompt=consent gives a refresh token, saved to
secrets/token.json; after that access tokens (1 hour) are refreshed from it without a browser.
The CLI logs in through a local browser (InstalledAppFlow); the server uses auth_url/finish_login.
"""
import os
import time
from pathlib import Path
import warnings

warnings.filterwarnings("ignore", category=FutureWarning, module="google")  # Python 3.9 EOL notice

import requests
from google.auth.exceptions import RefreshError
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow, InstalledAppFlow

from .db import ROOT

BASE_URL = "https://health.googleapis.com/v4/users/me"
SECRETS = Path(os.environ.get("HEALTH_SECRETS", ROOT / "secrets"))
CLIENT_SECRET = SECRETS / "client_secret.json"
TOKEN = SECRETS / "token.json"
SCOPES = [
    "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
    "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
    "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
    "https://www.googleapis.com/auth/googlehealth.location.readonly",
]


class LoginRequired(Exception):
    """No usable refresh token: the Google consent has to be run again."""


def credentials(interactive=True):
    """Load the saved token, refreshing it. If there is no usable token, run the browser login
    (interactive) or raise LoginRequired (server)."""
    creds = None
    if TOKEN.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN), SCOPES)
    if creds and creds.valid:
        return creds
    reason = "no saved login" if not creds else "saved login has no refresh token"
    if creds and creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
            _save(creds)
            return creds
        except RefreshError as e:
            reason = f"saved login was rejected by Google: {e}"
            if interactive:
                print("Saved login has expired (Testing-mode tokens last 7 days); logging in again.")
    if not interactive:
        raise LoginRequired(reason)
    flow = InstalledAppFlow.from_client_secrets_file(str(CLIENT_SECRET), SCOPES)
    creds = flow.run_local_server(port=0, access_type="offline", prompt="consent")
    _save(creds)
    return creds


def auth_url(redirect_uri):
    """Start the server-side consent. Returns (url to send the browser to, state, PKCE verifier);
    keep state and verifier for finish_login."""
    flow = Flow.from_client_secrets_file(str(CLIENT_SECRET), SCOPES, redirect_uri=redirect_uri)
    # prompt=consent makes Google return a refresh token even if consent was given before.
    url, state = flow.authorization_url(access_type="offline", prompt="consent", include_granted_scopes="true")
    return url, state, flow.code_verifier


def finish_login(redirect_uri, state, code_verifier, authorization_response):
    """Exchange the callback's code for tokens and save them. Raises LoginRequired if Google
    didn't return a refresh token."""
    flow = Flow.from_client_secrets_file(str(CLIENT_SECRET), SCOPES, redirect_uri=redirect_uri, state=state,
                                         code_verifier=code_verifier, autogenerate_code_verifier=False)
    flow.fetch_token(authorization_response=authorization_response)
    creds = flow.credentials
    if not creds.refresh_token:
        raise LoginRequired("Google returned no refresh token; remove the app's access in your Google "
                            "Account settings and connect again")
    _save(creds)
    return creds


def _save(creds):
    TOKEN.write_text(creds.to_json())
    try:
        TOKEN.chmod(0o600)
    except OSError:
        pass


class Client:
    def __init__(self, interactive=True):
        self.creds = credentials(interactive)
        self.http = requests.Session()

    def get(self, path, params=None):
        for attempt in range(6):
            if not self.creds.valid:
                self.creds.refresh(Request())
                _save(self.creds)
            r = self.http.get(
                f"{BASE_URL}/{path}", params=params,
                headers={"Authorization": f"Bearer {self.creds.token}"}, timeout=120,
            )
            if r.status_code in (429, 500, 502, 503, 504):
                time.sleep(min(60, 2 ** attempt))
                continue
            if not r.ok:
                raise ApiError(r.status_code, r.text, r.url)
            return r.json()
        raise ApiError(r.status_code, r.text, r.url)

    def list_points(self, data_type, filter=None, page_size=None):
        """Yield each response page of dataPoints.list."""
        params = {}
        if filter:
            params["filter"] = filter
        if page_size:
            params["pageSize"] = page_size
        while True:
            page = self.get(f"dataTypes/{data_type}/dataPoints", params)
            yield page
            token = page.get("nextPageToken")
            if not token:
                return
            params["pageToken"] = token


class ApiError(Exception):
    def __init__(self, status, body, url):
        super().__init__(f"HTTP {status} for {url}: {body[:500]}")
        self.status = status
        self.body = body
