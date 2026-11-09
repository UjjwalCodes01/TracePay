#!/usr/bin/env bash
# After judging, the demo shouldn't keep an instance (and its bill) running for months: on
# 1 January 2027 this drops Cloud Run's minimum instances to 0, so an idle site costs nothing and
# simply starts on the next visit. Runs as its own service account, allowed to change this one
# service and nothing else.
#   bash deploy/schedule-scale-down.sh
set -euo pipefail

PROJECT=tracepay-ai-1023775
REGION=us-east5
SERVICE=tracepay
SA_NAME=tracepay-scheduler
SA=$SA_NAME@$PROJECT.iam.gserviceaccount.com
RUN_SA=tracepay-api@$PROJECT.iam.gserviceaccount.com

gcloud services enable cloudscheduler.googleapis.com --project $PROJECT
gcloud iam service-accounts describe "$SA" --project $PROJECT >/dev/null 2>&1 ||
  gcloud iam service-accounts create $SA_NAME --project $PROJECT --display-name="TracePay: scale down after judging"
# Edit this one service (a new revision with min instances 0)…
gcloud run services add-iam-policy-binding $SERVICE --project $PROJECT --region $REGION --member="serviceAccount:$SA" --role=roles/run.developer >/dev/null
# …whose revisions run as the app's own account.
gcloud iam service-accounts add-iam-policy-binding "$RUN_SA" --project $PROJECT --member="serviceAccount:$SA" --role=roles/iam.serviceAccountUser >/dev/null

URI="https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/services/$SERVICE?updateMask=template.scaling.minInstanceCount"
gcloud scheduler jobs describe tracepay-scale-down --project $PROJECT --location $REGION >/dev/null 2>&1 && gcloud scheduler jobs delete tracepay-scale-down --project $PROJECT --location $REGION --quiet
gcloud scheduler jobs create http tracepay-scale-down --project $PROJECT --location $REGION \
  --schedule="0 0 1 1 *" --time-zone="Etc/UTC" \
  --uri="$URI" --http-method=PATCH \
  --headers="Content-Type=application/json" \
  --message-body='{"template":{"scaling":{"minInstanceCount":0}}}' \
  --oauth-service-account-email="$SA" --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform" \
  --description="After judging: min instances 0 so the idle demo costs nothing"
echo "Scheduled: on 1 January (UTC) $SERVICE scales to zero when idle."
