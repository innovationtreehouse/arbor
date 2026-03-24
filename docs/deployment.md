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

Add these in **Settings → Secrets and variables → Actions**. See [aws-setup.md](aws-setup.md) for how to provision the underlying AWS resources and obtain these values.

| Secret | Purpose |
|---|---|
| `AWS_ROLE_DEV` | IAM role ARN assumed by deploy-dev via OIDC |
| `AWS_ROLE_PROD` | IAM role ARN assumed by promote-prod via OIDC |
| `AWS_REGION` | e.g. `us-east-1` |
| `AWS_ACCOUNT_ID` | AWS account ID |
| `LAMBDA_ARTIFACT_BUCKET` | S3 bucket name for Lambda zips |
| `DATABASE_URL_DEV` | Postgres connection string for dev migrations |
| `DATABASE_URL_PROD` | Postgres connection string for prod migrations |
| `API_URL_DEV` | API Gateway URL for dev smoke test |
| `API_URL_PROD` | API Gateway URL for prod smoke test |

Workflows authenticate to AWS via OIDC (`aws-actions/configure-aws-credentials` with `role-to-assume`). No long-lived access keys are used.

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

The full workflow is in [`.github/workflows/deploy-dev.yml`](../.github/workflows/deploy-dev.yml).

The smoke test sends an intentionally invalid Slack signature and asserts the Lambda returns 401 with a non-empty body. This confirms the function is deployed, reachable, and running signature verification — without requiring a real Slack event.

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

The full workflow is in [`.github/workflows/promote-prod.yml`](../.github/workflows/promote-prod.yml).

### Manual Approval Gate

In **Settings → Environments**, create a `production` environment and add required reviewers. When the promote workflow runs, GitHub will pause after the job is queued and notify reviewers. The job only proceeds after an explicit approval. This prevents accidental or unauthorized promotions.

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
