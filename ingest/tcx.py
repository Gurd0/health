"""Parse Garmin TCX (Google Fit takeout files and the Health API's exportExerciseTcx)."""
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

NS = "{http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2}"


def to_utc(s):
    """'2026-10-11T11:39:00.000+02:00' / '...Z' -> naive UTC datetime."""
    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def _float(s):
    return float(s) if s not in (None, "") else None


def trackpoints(root):
    """Yield one dict per <Trackpoint> with ts_utc, latitude, longitude, altitude_m, distance_m, heart_rate."""
    for tp in root.iter(f"{NS}Trackpoint"):
        t = tp.findtext(f"{NS}Time")
        if not t:
            continue
        yield {
            "ts_utc": to_utc(t),
            "latitude": _float(tp.findtext(f"{NS}Position/{NS}LatitudeDegrees")),
            "longitude": _float(tp.findtext(f"{NS}Position/{NS}LongitudeDegrees")),
            "altitude_m": _float(tp.findtext(f"{NS}AltitudeMeters")),
            "distance_m": _float(tp.findtext(f"{NS}DistanceMeters")),
            "heart_rate": _float(tp.findtext(f"{NS}HeartRateBpm/{NS}Value")),
        }


def parse_file(path):
    return list(trackpoints(ET.parse(path).getroot()))


def parse_text(text):
    return list(trackpoints(ET.fromstring(text.encode("utf-8"))))
