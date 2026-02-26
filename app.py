"""
KL Traffic LOS Dashboard — Flask App
=====================================
Run with:  python app.py
Then open: http://localhost:5000
"""

import json
import os
import sys
import csv

from flask import Flask, jsonify, render_template, request

# ── Optional: import pipeline so we can re-process on upload ──────────────────
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "pipeline"))
import process_data

app = Flask(__name__)

HERE     = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")

GEOJSON_FILE = os.path.join(DATA_DIR, "road_geometries.geojson")
XLSX_FILE    = os.path.join(DATA_DIR, "Traffic_LOS_Report.xlsx")
PREDICTED_XLSX_FILE = os.path.join(DATA_DIR, "predicted.xlsx")

# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    """Serve the dashboard."""
    return render_template("index.html")


@app.route("/api/traffic-data")
def traffic_data():
    """
    Return all processed traffic data + road coords as JSON.
    The frontend fetches this on load and after any upload.
    """
    try:
        data, coords, bounds, date_label, road_count = process_data.run(
            GEOJSON_FILE, XLSX_FILE
        )
        return jsonify(
            success=True,
            trafficData=data,
            roadCoords=coords,
            mapBounds=bounds,
            dateLabel=date_label,
            roadCount=road_count,
        )
    except FileNotFoundError as e:
        return jsonify(success=False, error=str(e)), 404
    except Exception as e:
        return jsonify(success=False, error=str(e)), 500
        

@app.route("/api/predicted-data")
def predicted_data():
    """Return predicted next-day traffic data."""
    try:
        data, coords, bounds, date_label, road_count = process_data.run(
            GEOJSON_FILE, PREDICTED_XLSX_FILE
        )
        return jsonify(
            success=True,
            trafficData=data,
            roadCoords=coords,
            mapBounds=bounds,
            dateLabel=date_label,
            roadCount=road_count,
        )
    except FileNotFoundError as e:
        return jsonify(success=False, error=str(e)), 404
    except Exception as e:
        return jsonify(success=False, error=str(e)), 500


@app.route("/api/upload", methods=["POST"])
def upload():
    """
    Accept an uploaded .xlsx or .geojson file and save it to data/.
    Returns updated traffic data immediately after saving.
    """
    if "file" not in request.files:
        return jsonify(success=False, error="No file provided"), 400

    f = request.files["file"]
    filename = f.filename.lower()

    if filename.endswith(".xlsx"):
        save_path = XLSX_FILE
    elif filename.endswith(".geojson") or filename.endswith(".json"):
        save_path = GEOJSON_FILE
    else:
        return jsonify(
            success=False,
            error="Unsupported file type. Please upload a .xlsx or .geojson file.",
        ), 400

    os.makedirs(DATA_DIR, exist_ok=True)
    f.save(save_path)

    # Re-process and return fresh data
    try:
        data, coords, bounds, date_label, road_count = process_data.run(
            GEOJSON_FILE, XLSX_FILE
        )
        return jsonify(
            success=True,
            message=f"File uploaded and data refreshed successfully.",
            trafficData=data,
            roadCoords=coords,
            mapBounds=bounds,
            dateLabel=date_label,
            roadCount=road_count,
        )
    except Exception as e:
        return jsonify(
            success=False,
            error=f"File saved but processing failed: {str(e)}",
        ), 500


@app.route("/api/camera-locations")
def camera_locations():
    """Return camera locations from CSV."""
    csv_path = os.path.join(DATA_DIR, "camera_locations.csv")
    try:
        cameras = []
        with open(csv_path, encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                lat = row.get("latitude (DD)", "").strip()
                lng = row.get("longitude (DD)", "").strip()
                if lat and lng and lat != "NULL" and lng != "NULL":
                    cameras.append({
                        "road":      row.get("road", ""),
                        "camera_id": row.get("camera_id", ""),
                        "lat":       float(lat),
                        "lng":       float(lng),
                    })
        return jsonify(success=True, cameras=cameras)
    except FileNotFoundError:
        return jsonify(success=False, error="camera_locations.csv not found"), 404
    except Exception as e:
        return jsonify(success=False, error=str(e)), 500



# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 55)
    print("  KL Traffic LOS Dashboard")
    print("  http://localhost:8000")
    print("=" * 55)
    app.run(debug=True, port=8000)
