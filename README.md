<img width="1913" height="907" alt="image" src="https://github.com/user-attachments/assets/8fa91012-8d6b-44ce-ae34-f063e02fd098" />

# FlowLab v0.1.0 (Alpha)

A Flask web app that displays an interactive Level of Service (LOS) map for monitored road corridors in Kuala Lumpur.

## Setup

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Place your data files in the data/ folder:
#      data/road_geometries.geojson
#      data/Traffic_LOS_Report.xlsx

# 3. Run the app
python app.py

# 4. Open in your browser
#    http://localhost:5000
```

## Project Structure

```
kl-traffic-los/
├── app.py                        # Flask server
├── requirements.txt
├── README.md
│
├── templates/
│   └── index.html                # Dashboard HTML (Jinja2 template)
│
├── static/
│   ├── css/
│   │   └── style.css             # All dashboard styles
│   └── js/
│       └── map.js                # Leaflet map + all dashboard logic
│
├── pipeline/
│   └── process_data.py           # Data processing (GeoJSON + Excel → JSON)
│
└── data/
    ├── road_geometries.geojson   # Road geometry (from get_roads.py)
    └── Traffic_LOS_Report.xlsx   # Traffic counts (your Excel report)
```

## Uploading New Data

While the dashboard is running, click **Upload Data** in the top-right corner
to upload a new `.xlsx` or `.geojson` file. The map refreshes automatically —
no restart needed.

## API Endpoints

| Endpoint           | Method | Description                              |
|--------------------|--------|------------------------------------------|
| `/`                | GET    | Serve the dashboard                      |
| `/api/traffic-data`| GET    | Return processed traffic data as JSON    |
| `/api/upload`      | POST   | Upload a new .xlsx or .geojson file      |
