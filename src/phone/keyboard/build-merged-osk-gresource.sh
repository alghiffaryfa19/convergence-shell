#!/bin/bash
# Build a merged OSK layouts GResource that combines the stock GNOME Shell
# layouts with our custom mobileOSK overrides.
#
# Usage:
#   ./build-merged-osk-gresource.sh <stock.gresource> <output.gresource>
#
# The stock GResource is extracted, our *-mobileOSK.json overrides replace
# the matching base layouts, and the result is recompiled into a single
# GResource file that can replace the stock one on disk.
#
# Requires: python3 with gi (PyGObject), glib-compile-resources

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STOCK="${1:-}"
OUTPUT="${2:-merged-osk-layouts.gresource}"

if [ -z "$STOCK" ]; then
    echo "Usage: $0 <stock-gnome-shell-osk-layouts.gresource> [output.gresource]"
    echo ""
    echo "Fetch the stock file from a device first:"
    echo "  scp user@phone:/usr/share/gnome-shell/gnome-shell-osk-layouts.gresource stock.gresource"
    exit 1
fi

if ! command -v glib-compile-resources &>/dev/null; then
    echo "Error: glib-compile-resources not found. Install glib2 dev tools."
    exit 1
fi

WORK=$(mktemp -d)
LAYOUTS_DIR="$WORK/org/gnome/shell/osk-layouts"
mkdir -p "$LAYOUTS_DIR"

echo "Extracting stock layouts from $STOCK..."
python3 -c "
import gi, sys, os
gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib

res = Gio.Resource.load('$STOCK')
children = res.enumerate_children('/org/gnome/shell/osk-layouts/', 0)
outdir = '$LAYOUTS_DIR'
count = 0
for name in children:
    path = '/org/gnome/shell/osk-layouts/' + name
    data = res.lookup_data(path, 0)
    with open(os.path.join(outdir, name), 'wb') as f:
        f.write(data.get_data())
    count += 1
print(f'Extracted {count} stock layouts')
"

# Apply our mobileOSK overrides: us-mobileOSK.json -> us.json, etc.
echo "Applying custom layout overrides..."
OVERRIDE_COUNT=0
for override in "$SCRIPT_DIR"/*-mobileOSK.json; do
    [ -f "$override" ] || continue
    base=$(basename "$override" | sed 's/-mobile\.json/.json/')
    if [ -f "$LAYOUTS_DIR/$base" ]; then
        cp "$override" "$LAYOUTS_DIR/$base"
        echo "  Replaced: $base"
    else
        cp "$override" "$LAYOUTS_DIR/$base"
        echo "  Added: $base"
    fi
    OVERRIDE_COUNT=$((OVERRIDE_COUNT + 1))
done
echo "Applied $OVERRIDE_COUNT override(s)"

# Generate the GResource XML
echo "Compiling merged GResource..."
XML="$WORK/osk-layouts.gresource.xml"
cat > "$XML" << 'XMLHEAD'
<?xml version="1.0" encoding="UTF-8"?>
<gresources>
  <gresource prefix="/org/gnome/shell/osk-layouts">
XMLHEAD

for f in "$LAYOUTS_DIR"/*.json; do
    name=$(basename "$f")
    echo "    <file>$name</file>" >> "$XML"
done

cat >> "$XML" << 'XMLTAIL'
  </gresource>
</gresources>
XMLTAIL

(cd "$LAYOUTS_DIR" && glib-compile-resources --sourcedir=. "$XML" --target="$WORK/output.gresource")

cp "$WORK/output.gresource" "$OUTPUT"
rm -rf "$WORK"

TOTAL=$(python3 -c "
import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio
res = Gio.Resource.load('$OUTPUT')
print(len(res.enumerate_children('/org/gnome/shell/osk-layouts/', 0)))
")
echo ""
echo "Built: $OUTPUT ($TOTAL layouts)"
echo ""
echo "Deploy to device:"
echo "  scp $OUTPUT user@phone:/tmp/"
echo "  ssh user@phone 'doas cp /tmp/$(basename "$OUTPUT") /usr/share/gnome-shell/gnome-shell-osk-layouts.gresource'"
