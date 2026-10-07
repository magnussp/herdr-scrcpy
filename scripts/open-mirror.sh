#!/bin/sh
# "Mirror Android device" action: open the mirror pane split to the right of
# the pane the action was invoked from (herdr picks a pane when there is none).
exec "$HERDR_BIN_PATH" plugin pane open \
  --plugin "$HERDR_PLUGIN_ID" --entrypoint mirror \
  --placement split --direction right \
  ${HERDR_PANE_ID:+--target-pane "$HERDR_PANE_ID"}
