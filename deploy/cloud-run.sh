#!/usr/bin/env bash
# Deploys TracePay (API + web app, one service) to Google Cloud Run.
#   gcloud builds submit --config cloudbuild.yaml --substitutions=_COMMIT=$(git rev-parse --short HEAD)
#   bash deploy/cloud-run.sh path/to/production.env
# The env file (never committed) holds DATABASE_URL, DATABASE_URL_UNPOOLED, PAYPAL_CLIENT_ID,
# PAYPAL_CLIENT_SECRET, AUDIT_SIGNING_PRIVATE_KEY, WEBHOOK_SECRET_KEY and DEMO_PAYEE_EMAILS.
# Secrets go to Secret Manager, readable only by the service's account; none is ever printed.
set -euo pipefail
cd "$(dirname "$0")/../.."

PROJECT=tracepay-ai-1023775
REGION=us-east5                      # Columbus, Ohio: next to the Neon database (aws us-east-2)
SERVICE=tracepay
SA=tracepay-api@$PROJECT.iam.gserviceaccount.com
IMAGE=$REGION-docker.pkg.dev/$PROJECT/tracepay/tracepay:${IMAGE_TAG:-latest}
PROJECT_NUMBER=$(gcloud projects describe $PROJECT --format='value(projectNumber)')
URL=https://$SERVICE-$PROJECT_NUMBER.$REGION.run.app
ENVFILE=${1:-.local/render.env}
export TRACEPAY_ENV_FILE="$ENVFILE"
[ -f "$ENVFILE" ] || { echo "No env file at $ENVFILE"; exit 1; }
val() { node -e "const fs=require('fs'),{parseEnv}=require('node:util');process.stdout.write(parseEnv(fs.readFileSync('$ENVFILE','utf8'))['$1']??'')"; }

echo "1/4 Secrets in Secret Manager (values piped from $ENVFILE, never printed)"
for NAME in DATABASE_URL DATABASE_URL_UNPOOLED PAYPAL_CLIENT_SECRET AUDIT_SIGNING_PRIVATE_KEY WEBHOOK_SECRET_KEY DEMO_PAYEE_EMAILS; do
  SECRET=tracepay-$(echo "$NAME" | tr 'A-Z_' 'a-z-')
  if gcloud secrets describe "$SECRET" --project $PROJECT >/dev/null 2>&1; then
    val "$NAME" | gcloud secrets versions add "$SECRET" --project $PROJECT --data-file=- >/dev/null
  else
    val "$NAME" | gcloud secrets create "$SECRET" --project $PROJECT --replication-policy=automatic --data-file=- >/dev/null
  fi
  gcloud secrets add-iam-policy-binding "$SECRET" --project $PROJECT --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor >/dev/null
  echo "   $SECRET"
done

echo "2/4 PayPal webhook for $URL"
WEBHOOK_ID=$(node deploy/paypal-webhook.mjs "$URL/api/webhooks/paypal")
echo "   id $WEBHOOK_ID"

echo "3/4 Cloud Run service $SERVICE ($REGION)"
# One instance, always on, CPU always allocated: no cold starts for judges, and the background
# workers (PayPal reconciliation, webhook retries) keep running between requests. One instance
# also keeps the in-memory rate limits and answer progress exact (no Redis needed).
HINT='sign in to PayPal as tp-buyer-8fjk@personal.example.com, password 2I2oZGc! (sandbox: test money only). Or pick “Debit or Credit Card” and use a PayPal sandbox test card.'
gcloud run deploy $SERVICE --project $PROJECT --region $REGION --image "$IMAGE" \
  --service-account "$SA" --allow-unauthenticated \
  --min-instances 1 --max-instances 1 --cpu 1 --memory 1Gi --no-cpu-throttling --concurrency 80 --timeout 300 \
  --set-secrets "DATABASE_URL=tracepay-database-url:latest,DATABASE_URL_UNPOOLED=tracepay-database-url-unpooled:latest,PAYPAL_CLIENT_SECRET=tracepay-paypal-client-secret:latest,AUDIT_SIGNING_PRIVATE_KEY=tracepay-audit-signing-private-key:latest,WEBHOOK_SECRET_KEY=tracepay-webhook-secret-key:latest,DEMO_PAYEE_EMAILS=tracepay-demo-payee-emails:latest" \
  --set-env-vars "^##^DEMO_MODE=true##DEMO_SHARED_BUYER=true##APP_BASE_URL=$URL##API_BASE_URL=$URL##CORS_ORIGINS=$URL##PAYPAL_ENV=sandbox##PAYPAL_CLIENT_ID=$(val PAYPAL_CLIENT_ID)##PAYPAL_WEBHOOK_ID=$WEBHOOK_ID##PAYPAL_SANDBOX_BUYER_HINT=$HINT##GOOGLE_CLOUD_PROJECT=$PROJECT##GOOGLE_CLOUD_LOCATION=global##VERTEX_MODEL=gemini-3.5-flash##TRUST_PROXY_HOPS=1##RATE_LIMIT_PER_MINUTE=300##AUTH_RATE_LIMIT=20##API_RATE_LIMIT_PER_MINUTE=600##DB_POOL_MAX=10##ANSWER_FEE_CENTS=2##LOG_LEVEL=info" \
  --quiet

echo "4/4 Check"
curl -s -m 30 "$URL/api/health"; echo
echo "Live at $URL"
