#!/bin/bash
# Downloads the public data one region's map is built from into raw/<region>/.
# Usage: scripts/fetch_region.sh <region> <west,south,east,north>
# Everything comes from public ArcGIS REST services: FAA ADDS (airspace, airports), US Census TIGERweb
# (city limits, counties, roads, water, campuses, prisons), USGS PAD-US 4.1 (protected and public land),
# EIA (power plants) and USACE NID (dams). Austin's zoning comes from the City of Austin (see README).
set -euo pipefail
REGION="$1"; B="$2"
OUT="$(cd "$(dirname "$0")/.." && pwd)/raw/$REGION"
mkdir -p "$OUT"/{faa,tiger,padus,eia,nid}
geo="geometry=$B&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outSR=4326&f=geojson&geometryPrecision=5"
get() { curl -sS -m 180 --retry 2 -o "$1" "$2"; printf '%-28s %8s bytes\n' "${1#$OUT/}" "$(wc -c < "$1")"; }

FAA=https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services
get "$OUT/faa/class_airspace2.geojson" "$FAA/Class_Airspace/FeatureServer/0/query?where=LOCAL_TYPE%20IN%20('CLASS_C','CLASS_D','CLASS_E2','CLASS_E3','CLASS_E4')&$geo&outFields=NAME,IDENT,LOCAL_TYPE,CLASS,LOWER_VAL,LOWER_CODE,UPPER_VAL,UPPER_CODE,WKHR_CODE,WKHR_RMK&maxAllowableOffset=0.0003"
get "$OUT/faa/sua.geojson" "$FAA/Special_Use_Airspace/FeatureServer/0/query?where=1%3D1&$geo&outFields=*"
get "$OUT/faa/airports.geojson" "$FAA/US_Airport/FeatureServer/0/query?where=1%3D1&$geo&outFields=*&resultRecordCount=2000"

T=https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb
get "$OUT/tiger/places.geojson" "$T/Places_CouSub_ConCity_SubMCD/MapServer/4/query?where=1%3D1&$geo&outFields=NAME,BASENAME,GEOID,LSADC,CENTLAT,CENTLON,INTPTLAT,INTPTLON&maxAllowableOffset=0.0004"
get "$OUT/tiger/counties.geojson" "$T/State_County/MapServer/1/query?where=1%3D1&$geo&outFields=NAME,BASENAME,GEOID,STATE,LSADC&maxAllowableOffset=0.001"
get "$OUT/tiger/primary.geojson" "$T/Transportation/MapServer/2/query?where=1%3D1&$geo&outFields=NAME,MTFCC,RTTYP&maxAllowableOffset=0.0003"
get "$OUT/tiger/secondary.geojson" "$T/Transportation/MapServer/6/query?where=1%3D1&$geo&outFields=NAME,MTFCC,RTTYP&maxAllowableOffset=0.0004"
get "$OUT/tiger/areahydro.geojson" "$T/Hydro/MapServer/1/query?where=AREAWATER%3E${MIN_WATER_M2:-400000}&$geo&outFields=NAME,MTFCC,AREAWATER&maxAllowableOffset=0.0002"
get "$OUT/tiger/prisons.geojson" "$T/Special_Land_Use_Areas/MapServer/1/query?where=1%3D1&$geo&outFields=NAME,MTFCC,AREALAND&maxAllowableOffset=0.0001"
get "$OUT/tiger/colleges.geojson" "$T/Special_Land_Use_Areas/MapServer/2/query?where=1%3D1&$geo&outFields=NAME,MTFCC,AREALAND&maxAllowableOffset=0.0001"

PAD=https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Fee_Managers_PADUS/FeatureServer/0/query
F="Category,Own_Type,Own_Name,Loc_Own,Mang_Type,Mang_Name,Loc_Mang,Des_Tp,Loc_Ds,Unit_Nm,Pub_Access,GIS_Acres"
for off in 0 2000 4000 6000 8000; do
  get "$OUT/padus/fee_$off.geojson" "$PAD?where=1%3D1&$geo&maxAllowableOffset=0.0002&outFields=$F&resultOffset=$off&resultRecordCount=2000&orderByFields=OBJECTID"
  n=$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log((j.features||[]).length)' "$OUT/padus/fee_$off.geojson")
  [ "$n" -lt 2000 ] && break
done

AG=https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services
get "$OUT/eia/plants.geojson" "$AG/Power_Plants_in_the_US/FeatureServer/0/query?where=1%3D1&$geo&outFields=Plant_Name,Utility_Na,PrimSource,Total_MW,City,County&resultRecordCount=2000"
get "$OUT/nid/dams_high.geojson" "$AG/NID_v1/FeatureServer/0/query?where=HAZARD_POTENTIAL%3D'High'&$geo&outFields=NAME,OTHER_NAMES,PRIMARY_OWNER_TYPE,HAZARD_POTENTIAL,NID_HEIGHT,RIVER_OR_STREAM,COUNTYSTATE,STATE_REGULATORY_AGENCY,OWNER_TYPES&resultRecordCount=2000"

case "$REGION" in
  austin)
    # City of Austin zoning, every lot, generalized to about 2 m by the server
    mkdir -p "$OUT/coa"
    Z=https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services/PLANNINGCADASTRE_zoning_large_map_scale/FeatureServer/0/query
    for off in $(seq 0 2000 30000); do
      get "$OUT/coa/zoning_$off.geojson" "$Z?where=1%3D1&outFields=OBJECTID,ZONING_ZTYPE,ZONING_BASE&orderByFields=OBJECTID&resultOffset=$off&resultRecordCount=2000&outSR=4326&maxAllowableOffset=0.00002&geometryPrecision=6&f=geojson"
      n=$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log((j.features||[]).length)' "$OUT/coa/zoning_$off.geojson")
      [ "$n" -lt 2000 ] && break
    done ;;
  blacksburg)
    # Forest Service wilderness, where landing aircraft is banned outright
    mkdir -p "$OUT/usfs"
    get "$OUT/usfs/wilderness.geojson" "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_Wilderness_01/MapServer/0/query?where=1%3D1&$geo&maxAllowableOffset=0.0002&outFields=wildernessname,gis_acres" ;;
esac
