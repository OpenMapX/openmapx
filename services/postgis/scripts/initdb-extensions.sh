#!/usr/bin/env bash
# Mounted over the PostGIS image's /docker-entrypoint-initdb.d/10_postgis.sh,
# which the image's entrypoint runs once, when it initialises an empty data
# directory. The image's script installs PostGIS into the `public` schema,
# which the API's role owns, and adds the `template_postgis` database and the
# topology and TIGER geocoder extensions, which OpenMapX does not use. PostGIS
# cannot be moved to another schema once installed.
#
# This replacement does nothing. The OpenMapX entrypoint (sync-password.sh)
# installs every extension into the superuser's `extensions` schema on each
# start, after initialisation. The image executes the file when it looks
# executable and sources it otherwise, and Docker Desktop's file sharing can
# make a file look executable that is not. So it is executable, and it never
# calls `exit`, which would end the image's entrypoint when the file is
# sourced.
:
