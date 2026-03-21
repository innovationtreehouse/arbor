# Deployment Guide

This document describes how to deploy Arbor to a dev environment automatically on every merge to `main`, and how to promote a tested build to production via a manual gate.

For initial infrastructure provisioning, see [aws-setup.md](aws-setup.md).

---

## Environment Structure

Two independent sets of AWS resources — dev and prod — are provisioned using the same setup script with different names. The simplest separation is a resource name prefix:

| Resource | Dev | Prod |
|---|---|---|
| ECS cluster | `arbor-dev` | `arbor-prod` |
| ECS task family | `arbor-agent-dev` | `arbor-agent-prod` |
| Lambda function | `arbor-webhook-dev` | `arbor-webhook-prod` |
| SQS queue | `arbor-events-dev` | `arbor-events-prod` |
| ECR repository | `arbor-agent` (shared) | `arbor-agent` (shared) |
| Secrets namespace | `arbor-dev/*` | `arbor-prod/*` |
| RDS identifier | `arbor-dev` | `arbor-prod` |
| API Gateway | `arbor-dev` | `arbor-prod` |

Separate AWS accounts are cleaner for strict blast-radius isolation, but a single account with prefixed resources is sufficient for most teams.

Each environment has its own Slack app (separate bot tokens, signing secrets, separate channels or workspace) to prevent dev traffic from reaching users.

---

## Image Tagging Strategy

The ECR repository holds a single image built per commit. Tags are immutable and meaningful:

| Tag | Meaning |
|---|---|
| `<git-sha>` | Canonical. Built once per merge to `main`. Never mutated. |
| `dev` | Mutable pointer. Updated on every successful dev deploy. |
| `prod` | Mutable pointer. Updated only by the promotion workflow. |

Promotion does not rebuild — it re-tags the existing SHA image and deploys it to prod. This guarantees the artifact running in prod is byte-for-byte identical to what was validated in dev.

---

## Required GitHub Secrets

Add these in **Settings → Secrets and variables → Actions**:

| Secret | Purpose |
|---|---|
| `AWS_ROLE_DEV` | IAM role ARN for dev deployments (OIDC) |
| `AWS_ROLE_PROD` | IAM role ARN for prod deployments (OIDC) |
| `AWS_REGION` | e.g. `us-east-1` |
| `AWS_ACCOUNT_ID` | AWS account ID (same for both if single-account) |

Using OIDC (`aws-actions/configure-aws-credentials` with `role-to-assume`) is strongly preferred over long-lived access keys. The IAM roles need permissions to push to ECR, update Lambda, register ECS task definitions, and run `drizzle-kit migrate`.

---

## Continuous Deployment to Dev

**Trigger:** Every push to `main` (i.e., every merged PR).

**Workflow:** `.github/workflows/deploy-dev.yml`

### Steps

```
merge to main
      │
      ▼
1. Build Lambda zip
      │
      ▼
2. Build Docker image, tag with git SHA
      │
      ▼
3. Push image to ECR as <sha> and dev
      │
      ▼
4. Run DB migrations against dev RDS
      │
      ▼
5. Update dev Lambda function code
      │
      ▼
6. Register new ECS task definition (dev cluster, new image SHA)
      │
      ▼
7. Smoke test
```

### Workflow File

```yaml
name: Deploy to Dev

on:
  push:
    branches: [main]

permissions:
  id-token: write
  contents: read

jobs:
  deploy-dev:
    name: Deploy to dev
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Configure AWS credentials (dev)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_DEV }}
          aws-region: ${{ secrets.AWS_REGION }}

      - name: Log in to ECR
        id: ecr-login
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build and push Docker image
        env:
          REGISTRY: ${{ steps.ecr-login.outputs.registry }}
          SHA: ${{ github.sha }}
        run: |
          docker build -t $REGISTRY/arbor-agent:$SHA \
                       -t $REGISTRY/arbor-agent:dev \
                       -f packages/agent/Dockerfile .
          docker push $REGISTRY/arbor-agent:$SHA
          docker push $REGISTRY/arbor-agent:dev

      - name: Build Lambda zip
        run: |
          npm run build
          cd packages/lambda/dist && zip -r ../lambda.zip .

      - name: Run database migrations (dev)
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL_DEV }}
        run: cd packages/db && npm run db:migrate

      - name: Deploy Lambda (dev)
        run: |
          aws lambda update-function-code \
            --function-name arbor-webhook-dev \
            --zip-file fileb://packages/lambda/lambda.zip

      - name: Register ECS task definition (dev)
        env:
          SHA: ${{ github.sha }}
          ACCOUNT: ${{ secrets.AWS_ACCOUNT_ID }}
          REGION: ${{ secrets.AWS_REGION }}
        run: |
          # Read the current task definition, swap the image tag, and register it
          aws ecs describe-task-definition \
            --task-definition arbor-agent-dev \
            --query taskDefinition \
          | jq --arg img "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/arbor-agent:$SHA" \
              'del(.taskDefinitionArn, .revision, .status, .requiresAttributes,
                   .compatibilities, .registeredAt, .registeredBy)
               | .containerDefinitions[0].image = $img' \
          > /tmp/task-def.json
          aws ecs register-task-definition --cli-input-json file:///tmp/task-def.json

      - name: Smoke test (dev)
        env:
          API_URL: ${{ secrets.API_URL_DEV }}
        run: |
          STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/slack/events" \
            -H "Content-Type: application/json" \
            -H "x-slack-request-timestamp: $(date +%s)" \
            -H "x-slack-signature: v0=badhash" \
            -d '{}')
          if [ "$STATUS" != "401" ]; then
            echo "Smoke test failed: expected 401, got $STATUS"
            exit 1
          fi
          echo "Smoke test passed."
```

The smoke test sends an intentionally invalid Slack signature and asserts the Lambda returns 401. This confirms the function is deployed, reachable, and running signature verification — without requiring a real Slack event.

---

## Promotion to Production

**Trigger:** Manual. A team member runs the workflow and specifies the git SHA to promote.

**Workflow:** `.github/workflows/promote-prod.yml`

Promotion does not build anything. It takes an already-deployed SHA from dev and deploys the same artifact to prod.

### Process

```
team member triggers promote-prod.yml
specifies: sha=<git-sha>
      │
      ▼
1. Verify the SHA image exists in ECR
      │
      ▼
2. Re-tag image as prod
      │
      ▼
3. Run DB migrations against prod RDS
      │
      ▼
4. Deploy Lambda zip for that SHA to prod
      │
      ▼
5. Register new ECS task definition (prod cluster, SHA image)
      │
      ▼
6. Smoke test (prod)
```

### Workflow File

```yaml
name: Promote to Production

on:
  workflow_dispatch:
    inputs:
      sha:
        description: "Git SHA to promote (must be deployed to dev)"
        required: true

permissions:
  id-token: write
  contents: read

jobs:
  promote:
    name: Promote ${{ inputs.sha }} to prod
    runs-on: ubuntu-latest
    environment: production   # requires manual approval if configured in repo settings

    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ inputs.sha }}

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Configure AWS credentials (prod)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_PROD }}
          aws-region: ${{ secrets.AWS_REGION }}

      - name: Log in to ECR
        id: ecr-login
        uses: aws-actions/amazon-ecr-login@v2

      - name: Verify image exists and re-tag as prod
        env:
          REGISTRY: ${{ steps.ecr-login.outputs.registry }}
          SHA: ${{ inputs.sha }}
        run: |
          # Fail fast if the SHA was never pushed (e.g. dev deploy never ran)
          docker pull $REGISTRY/arbor-agent:$SHA
          docker tag  $REGISTRY/arbor-agent:$SHA $REGISTRY/arbor-agent:prod
          docker push $REGISTRY/arbor-agent:prod

      - name: Run database migrations (prod)
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL_PROD }}
        run: cd packages/db && npm run db:migrate

      - name: Build Lambda zip
        run: |
          npm run build
          cd packages/lambda/dist && zip -r ../lambda.zip .

      - name: Deploy Lambda (prod)
        run: |
          aws lambda update-function-code \
            --function-name arbor-webhook-prod \
            --zip-file fileb://packages/lambda/lambda.zip

      - name: Register ECS task definition (prod)
        env:
          SHA: ${{ inputs.sha }}
          ACCOUNT: ${{ secrets.AWS_ACCOUNT_ID }}
          REGION: ${{ secrets.AWS_REGION }}
        run: |
          aws ecs describe-task-definition \
            --task-definition arbor-agent-prod \
            --query taskDefinition \
          | jq --arg img "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/arbor-agent:$SHA" \
              'del(.taskDefinitionArn, .revision, .status, .requiresAttributes,
                   .compatibilities, .registeredAt, .registeredBy)
               | .containerDefinitions[0].image = $img' \
          > /tmp/task-def.json
          aws ecs register-task-definition --cli-input-json file:///tmp/task-def.json

      - name: Smoke test (prod)
        env:
          API_URL: ${{ secrets.API_URL_PROD }}
        run: |
          STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/slack/events" \
            -H "Content-Type: application/json" \
            -H "x-slack-request-timestamp: $(date +%s)" \
            -H "x-slack-signature: v0=badhash" \
            -d '{}')
          if [ "$STATUS" != "401" ]; then
            echo "Smoke test failed: expected 401, got $STATUS"
            exit 1
          fi
          echo "Smoke test passed."
```

### Manual Approval Gate

In **Settings → Environments**, create a `production` environment and add required reviewers. When the promote workflow runs, GitHub will pause after the job is queued and notify reviewers. The job only proceeds after an explicit approval. This prevents accidental or unauthorized promotions.

---

## Additional Secrets Required

Add these alongside the existing secrets:

| Secret | Used by |
|---|---|
| `DATABASE_URL_DEV` | Deploy-dev migration step |
| `DATABASE_URL_PROD` | Promote-prod migration step |
| `API_URL_DEV` | Deploy-dev smoke test |
| `API_URL_PROD` | Promote-prod smoke test |

---

## Database Migration Safety

Migrations run via `drizzle-kit migrate` against the target environment's `DATABASE_URL`. A few properties of this approach worth understanding:

- **Dev runs first.** The deploy-dev workflow runs migrations before updating Lambda or the ECS task definition. Any migration that errors will fail the deploy before traffic is affected.
- **Prod runs on promotion.** Migrations run against prod before the Lambda zip is deployed. If the migration fails, the old Lambda and task definition remain active.
- **Migrations must be backwards-compatible.** Because the ECS Fargate task is long-running, there will be a brief window where the new Lambda code is deployed but the existing ECS task is still running the old agent code against the new schema. Avoid breaking schema changes (column renames, drops) without a multi-step migration strategy.
- **Migration files are version-controlled.** The `packages/db/drizzle/` directory is committed to the repository. `drizzle-kit migrate` applies only the unapplied migrations, making it safe to run repeatedly.

---

## Rollback

### Lambda rollback

Lambda retains previous versions. Roll back immediately by pointing the function alias (or updating the function code) to the prior deployment:

```bash
# List recent versions
aws lambda list-versions-by-function --function-name arbor-webhook-prod

# Publish and alias strategy (recommended for zero-downtime rollback):
# Configure a Lambda alias pointing to the current version, then update it to a prior version.
```

### ECS task rollback

Re-run the promote workflow with the previous git SHA. The ECS task definition will be updated to the prior image. Any currently running container will finish its current event and the next task launch will use the new (rolled-back) definition.

### Database rollback

Drizzle does not automatically generate down migrations. If a migration needs to be reversed, write a new migration that undoes the change. Do not delete or edit committed migration files.

---

## Deployment Checklist

Before running a production promotion:

- [ ] Dev smoke test passed in CI
- [ ] Integration tests passed on the SHA being promoted
- [ ] Any new environment variables added to prod Secrets Manager
- [ ] Database migration reviewed for backwards compatibility
- [ ] Promotion reviewed and approved in GitHub environment gate
