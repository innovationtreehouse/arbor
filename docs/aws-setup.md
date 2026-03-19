# AWS Setup Procedure

This document provisions all AWS infrastructure required to run Arbor. The setup is a single shell script you can copy and run after filling in the configuration block at the top.

## Prerequisites

- AWS CLI v2 configured with IAM credentials that have admin (or equivalently scoped) permissions
- Docker installed locally
- Arbor repository cloned and `npm install` run

## How to use this document

1. Copy the script below into a file (e.g. `setup.sh`)
2. Fill in the values in the **Configuration** block at the top
3. Run: `bash setup.sh`

The script is also safe to run section by section in a terminal — variable names are consistent throughout.

---

## Setup Script

```bash
#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Configuration — fill these in before running
# =============================================================================

AWS_REGION="us-east-1"
DB_PASSWORD="change-me-use-something-strong"
SLACK_SIGNING_SECRET="your-slack-signing-secret"
SLACK_BOT_TOKEN="xoxb-your-bot-token"
ANTHROPIC_API_KEY="sk-ant-your-key"
GOOGLE_CREDENTIALS_FILE="/path/to/service-account.json"
GITHUB_TOKEN="ghp_your-token"
ADMIN_USER_IDS="U12345678"   # comma-separated Slack user IDs for /squirrel-admin

# =============================================================================
# Derived — do not edit
# =============================================================================

export AWS_REGION
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "Account: $AWS_ACCOUNT_ID  Region: $AWS_REGION"


# =============================================================================
# 1. Networking
# =============================================================================

echo "--- 1. Networking ---"

VPC_ID=$(aws ec2 create-vpc \
  --cidr-block 10.0.0.0/16 \
  --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=arbor}]' \
  --query Vpc.VpcId --output text)

aws ec2 modify-vpc-attribute --vpc-id "$VPC_ID" --enable-dns-hostnames
aws ec2 modify-vpc-attribute --vpc-id "$VPC_ID" --enable-dns-support

PRIVATE_SUBNET_A=$(aws ec2 create-subnet \
  --vpc-id "$VPC_ID" --cidr-block 10.0.1.0/24 \
  --availability-zone "${AWS_REGION}a" \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=arbor-private-a}]' \
  --query Subnet.SubnetId --output text)

PRIVATE_SUBNET_B=$(aws ec2 create-subnet \
  --vpc-id "$VPC_ID" --cidr-block 10.0.2.0/24 \
  --availability-zone "${AWS_REGION}b" \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=arbor-private-b}]' \
  --query Subnet.SubnetId --output text)

PUBLIC_SUBNET=$(aws ec2 create-subnet \
  --vpc-id "$VPC_ID" --cidr-block 10.0.0.0/24 \
  --availability-zone "${AWS_REGION}a" \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=arbor-public}]' \
  --query Subnet.SubnetId --output text)

IGW_ID=$(aws ec2 create-internet-gateway \
  --tag-specifications 'ResourceType=internet-gateway,Tags=[{Key=Name,Value=arbor-igw}]' \
  --query InternetGateway.InternetGatewayId --output text)
aws ec2 attach-internet-gateway --internet-gateway-id "$IGW_ID" --vpc-id "$VPC_ID"

EIP_ALLOC=$(aws ec2 allocate-address --domain vpc --query AllocationId --output text)

NAT_GW_ID=$(aws ec2 create-nat-gateway \
  --subnet-id "$PUBLIC_SUBNET" \
  --allocation-id "$EIP_ALLOC" \
  --tag-specifications 'ResourceType=natgateway,Tags=[{Key=Name,Value=arbor-nat}]' \
  --query NatGateway.NatGatewayId --output text)

echo "Waiting for NAT gateway..."
aws ec2 wait nat-gateway-available --nat-gateway-ids "$NAT_GW_ID"

PUBLIC_RT=$(aws ec2 create-route-table --vpc-id "$VPC_ID" \
  --query RouteTable.RouteTableId --output text)
aws ec2 create-route --route-table-id "$PUBLIC_RT" \
  --destination-cidr-block 0.0.0.0/0 --gateway-id "$IGW_ID"
aws ec2 associate-route-table --route-table-id "$PUBLIC_RT" --subnet-id "$PUBLIC_SUBNET"

PRIVATE_RT=$(aws ec2 create-route-table --vpc-id "$VPC_ID" \
  --query RouteTable.RouteTableId --output text)
aws ec2 create-route --route-table-id "$PRIVATE_RT" \
  --destination-cidr-block 0.0.0.0/0 --nat-gateway-id "$NAT_GW_ID"
aws ec2 associate-route-table --route-table-id "$PRIVATE_RT" --subnet-id "$PRIVATE_SUBNET_A"
aws ec2 associate-route-table --route-table-id "$PRIVATE_RT" --subnet-id "$PRIVATE_SUBNET_B"

RDS_SG=$(aws ec2 create-security-group \
  --group-name arbor-rds --description "Arbor RDS" --vpc-id "$VPC_ID" \
  --query GroupId --output text)

APP_SG=$(aws ec2 create-security-group \
  --group-name arbor-app --description "Arbor Lambda and ECS" --vpc-id "$VPC_ID" \
  --query GroupId --output text)

aws ec2 authorize-security-group-ingress \
  --group-id "$RDS_SG" --protocol tcp --port 5432 --source-group "$APP_SG"

# VPC endpoints — keep AWS API traffic off the NAT gateway
# A security group for the interface endpoints: accept HTTPS from Lambda/ECS
ENDPOINT_SG=$(aws ec2 create-security-group \
  --group-name arbor-endpoints \
  --description "Arbor VPC interface endpoints" \
  --vpc-id "$VPC_ID" \
  --query GroupId --output text)

aws ec2 authorize-security-group-ingress \
  --group-id "$ENDPOINT_SG" --protocol tcp --port 443 --source-group "$APP_SG"

# S3 gateway endpoint (free; ECR stores image layers in S3)
aws ec2 create-vpc-endpoint \
  --vpc-id "$VPC_ID" \
  --service-name "com.amazonaws.${AWS_REGION}.s3" \
  --vpc-endpoint-type Gateway \
  --route-table-ids "$PRIVATE_RT"

# ECR — two endpoints are required together
aws ec2 create-vpc-endpoint \
  --vpc-id "$VPC_ID" \
  --service-name "com.amazonaws.${AWS_REGION}.ecr.api" \
  --vpc-endpoint-type Interface \
  --subnet-ids "$PRIVATE_SUBNET_A" "$PRIVATE_SUBNET_B" \
  --security-group-ids "$ENDPOINT_SG" \
  --private-dns-enabled

aws ec2 create-vpc-endpoint \
  --vpc-id "$VPC_ID" \
  --service-name "com.amazonaws.${AWS_REGION}.ecr.dkr" \
  --vpc-endpoint-type Interface \
  --subnet-ids "$PRIVATE_SUBNET_A" "$PRIVATE_SUBNET_B" \
  --security-group-ids "$ENDPOINT_SG" \
  --private-dns-enabled

# SQS — Lambda sends to it; ECS polls it
aws ec2 create-vpc-endpoint \
  --vpc-id "$VPC_ID" \
  --service-name "com.amazonaws.${AWS_REGION}.sqs" \
  --vpc-endpoint-type Interface \
  --subnet-ids "$PRIVATE_SUBNET_A" "$PRIVATE_SUBNET_B" \
  --security-group-ids "$ENDPOINT_SG" \
  --private-dns-enabled

# Secrets Manager — Lambda and ECS execution role fetch secrets at startup
aws ec2 create-vpc-endpoint \
  --vpc-id "$VPC_ID" \
  --service-name "com.amazonaws.${AWS_REGION}.secretsmanager" \
  --vpc-endpoint-type Interface \
  --subnet-ids "$PRIVATE_SUBNET_A" "$PRIVATE_SUBNET_B" \
  --security-group-ids "$ENDPOINT_SG" \
  --private-dns-enabled

# CloudWatch Logs — ECS task log delivery
aws ec2 create-vpc-endpoint \
  --vpc-id "$VPC_ID" \
  --service-name "com.amazonaws.${AWS_REGION}.logs" \
  --vpc-endpoint-type Interface \
  --subnet-ids "$PRIVATE_SUBNET_A" "$PRIVATE_SUBNET_B" \
  --security-group-ids "$ENDPOINT_SG" \
  --private-dns-enabled

echo "Networking done. VPC=$VPC_ID"


# =============================================================================
# 2. Database (RDS PostgreSQL)
# =============================================================================

echo "--- 2. Database ---"

aws rds create-db-subnet-group \
  --db-subnet-group-name arbor-db-subnets \
  --db-subnet-group-description "Arbor DB subnets" \
  --subnet-ids "$PRIVATE_SUBNET_A" "$PRIVATE_SUBNET_B"

aws rds create-db-instance \
  --db-instance-identifier arbor-db \
  --db-instance-class db.t4g.micro \
  --engine postgres \
  --engine-version 16 \
  --master-username arbor \
  --master-user-password "$DB_PASSWORD" \
  --db-name arbor \
  --allocated-storage 20 \
  --storage-type gp3 \
  --no-publicly-accessible \
  --vpc-security-group-ids "$RDS_SG" \
  --db-subnet-group-name arbor-db-subnets \
  --backup-retention-period 7 \
  --no-multi-az

echo "Waiting for RDS instance (5-10 min)..."
aws rds wait db-instance-available --db-instance-identifier arbor-db

DB_HOST=$(aws rds describe-db-instances \
  --db-instance-identifier arbor-db \
  --query 'DBInstances[0].Endpoint.Address' --output text)

DATABASE_URL="postgres://arbor:${DB_PASSWORD}@${DB_HOST}/arbor"
echo "Database ready. Host=$DB_HOST"

# Create the schema via psql from within the VPC.
# If you have a bastion or SSM session, run this SQL manually:
#
#   CREATE TABLE url_config (
#     url         TEXT PRIMARY KEY,
#     description TEXT        NOT NULL,
#     enabled     BOOLEAN     NOT NULL DEFAULT true,
#     added_by    TEXT        NOT NULL,
#     added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
#   );
#
# Or if psql is available and reachable from this machine:
# psql "$DATABASE_URL" -c "CREATE TABLE IF NOT EXISTS url_config (
#   url TEXT PRIMARY KEY, description TEXT NOT NULL,
#   enabled BOOLEAN NOT NULL DEFAULT true,
#   added_by TEXT NOT NULL, added_at TIMESTAMPTZ NOT NULL DEFAULT NOW());"


# =============================================================================
# 3. Secrets Manager
# =============================================================================

echo "--- 3. Secrets ---"

aws secretsmanager create-secret \
  --name arbor/database-url \
  --secret-string "$DATABASE_URL"

aws secretsmanager create-secret \
  --name arbor/slack-signing-secret \
  --secret-string "$SLACK_SIGNING_SECRET"

aws secretsmanager create-secret \
  --name arbor/slack-bot-token \
  --secret-string "$SLACK_BOT_TOKEN"

aws secretsmanager create-secret \
  --name arbor/anthropic-api-key \
  --secret-string "$ANTHROPIC_API_KEY"

aws secretsmanager create-secret \
  --name arbor/google-credentials \
  --secret-string "$(cat "$GOOGLE_CREDENTIALS_FILE")"

aws secretsmanager create-secret \
  --name arbor/github-token \
  --secret-string "$GITHUB_TOKEN"

echo "Secrets stored."


# =============================================================================
# 4. SQS
# =============================================================================

echo "--- 4. SQS ---"

QUEUE_URL=$(aws sqs create-queue \
  --queue-name arbor-events \
  --attributes '{
    "VisibilityTimeout":          "300",
    "MessageRetentionPeriod":     "86400",
    "ReceiveMessageWaitTimeSeconds": "20"
  }' \
  --query QueueUrl --output text)

QUEUE_ARN=$(aws sqs get-queue-attributes \
  --queue-url "$QUEUE_URL" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

echo "Queue: $QUEUE_URL"


# =============================================================================
# 5. ECR and Docker image
# =============================================================================

echo "--- 5. ECR ---"

aws ecr create-repository --repository-name arbor-agent

aws ecr get-login-password | docker login \
  --username AWS \
  --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

docker build -t arbor-agent -f packages/agent/Dockerfile .
docker tag arbor-agent \
  "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/arbor-agent:latest"
docker push \
  "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/arbor-agent:latest"

echo "Image pushed."


# =============================================================================
# 6. IAM roles
# =============================================================================

echo "--- 6. IAM ---"

# Lambda execution role
aws iam create-role \
  --role-name arbor-lambda-role \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

aws iam attach-role-policy \
  --role-name arbor-lambda-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole

aws iam put-role-policy \
  --role-name arbor-lambda-role \
  --policy-name arbor-lambda-policy \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {\"Effect\":\"Allow\",\"Action\":[\"sqs:SendMessage\"],\"Resource\":\"$QUEUE_ARN\"},
      {\"Effect\":\"Allow\",\"Action\":[\"ecs:ListTasks\",\"ecs:RunTask\"],\"Resource\":\"*\"},
      {\"Effect\":\"Allow\",\"Action\":\"iam:PassRole\",\"Resource\":\"arn:aws:iam::${AWS_ACCOUNT_ID}:role/arbor-ecs-task-role\"},
      {\"Effect\":\"Allow\",\"Action\":\"secretsmanager:GetSecretValue\",\"Resource\":\"arn:aws:secretsmanager:${AWS_REGION}:${AWS_ACCOUNT_ID}:secret:arbor/*\"}
    ]
  }"

# ECS task execution role (pulls image, injects secrets)
aws iam create-role \
  --role-name arbor-ecs-execution-role \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

aws iam attach-role-policy \
  --role-name arbor-ecs-execution-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

aws iam put-role-policy \
  --role-name arbor-ecs-execution-role \
  --policy-name arbor-secrets-policy \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"secretsmanager:GetSecretValue\",\"Resource\":\"arn:aws:secretsmanager:${AWS_REGION}:${AWS_ACCOUNT_ID}:secret:arbor/*\"}]}"

# ECS task role (runtime SQS access)
aws iam create-role \
  --role-name arbor-ecs-task-role \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

aws iam put-role-policy \
  --role-name arbor-ecs-task-role \
  --policy-name arbor-ecs-task-policy \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"sqs:ReceiveMessage\",\"sqs:DeleteMessage\",\"sqs:GetQueueAttributes\"],\"Resource\":\"$QUEUE_ARN\"}]}"

echo "IAM roles created."


# =============================================================================
# 7. ECS cluster and task definition
# =============================================================================

echo "--- 7. ECS ---"

aws ecs create-cluster --cluster-name arbor --capacity-providers FARGATE

aws logs create-log-group --log-group-name /ecs/arbor-agent

cat > /tmp/arbor-task-definition.json <<EOF
{
  "family": "arbor-agent",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "executionRoleArn": "arn:aws:iam::${AWS_ACCOUNT_ID}:role/arbor-ecs-execution-role",
  "taskRoleArn": "arn:aws:iam::${AWS_ACCOUNT_ID}:role/arbor-ecs-task-role",
  "containerDefinitions": [{
    "name": "arbor-agent",
    "image": "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/arbor-agent:latest",
    "essential": true,
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": {
        "awslogs-group": "/ecs/arbor-agent",
        "awslogs-region": "${AWS_REGION}",
        "awslogs-stream-prefix": "ecs"
      }
    },
    "secrets": [
      {"name":"DATABASE_URL",       "valueFrom":"arn:aws:secretsmanager:${AWS_REGION}:${AWS_ACCOUNT_ID}:secret:arbor/database-url"},
      {"name":"SLACK_BOT_TOKEN",    "valueFrom":"arn:aws:secretsmanager:${AWS_REGION}:${AWS_ACCOUNT_ID}:secret:arbor/slack-bot-token"},
      {"name":"ANTHROPIC_API_KEY",  "valueFrom":"arn:aws:secretsmanager:${AWS_REGION}:${AWS_ACCOUNT_ID}:secret:arbor/anthropic-api-key"},
      {"name":"GOOGLE_CREDENTIALS", "valueFrom":"arn:aws:secretsmanager:${AWS_REGION}:${AWS_ACCOUNT_ID}:secret:arbor/google-credentials"},
      {"name":"GITHUB_TOKEN",       "valueFrom":"arn:aws:secretsmanager:${AWS_REGION}:${AWS_ACCOUNT_ID}:secret:arbor/github-token"}
    ],
    "environment": [
      {"name":"SQS_QUEUE_URL","value":"${QUEUE_URL}"},
      {"name":"AWS_REGION",   "value":"${AWS_REGION}"}
    ]
  }]
}
EOF

aws ecs register-task-definition --cli-input-json file:///tmp/arbor-task-definition.json
echo "ECS cluster and task definition registered."


# =============================================================================
# 8. Lambda function and API Gateway
# =============================================================================

echo "--- 8. Lambda ---"

(cd packages/lambda && npm run build && cd dist && zip -r ../lambda.zip .)

LAMBDA_ARN=$(aws lambda create-function \
  --function-name arbor-webhook \
  --runtime nodejs20.x \
  --role "arn:aws:iam::${AWS_ACCOUNT_ID}:role/arbor-lambda-role" \
  --handler index.handler \
  --zip-file fileb://packages/lambda/lambda.zip \
  --timeout 30 \
  --memory-size 256 \
  --vpc-config "SubnetIds=${PRIVATE_SUBNET_A},${PRIVATE_SUBNET_B},SecurityGroupIds=${APP_SG}" \
  --query FunctionArn --output text)

aws lambda update-function-configuration \
  --function-name arbor-webhook \
  --environment "Variables={
    SQS_QUEUE_URL=${QUEUE_URL},
    ECS_CLUSTER=arbor,
    ECS_TASK_FAMILY=arbor-agent,
    ECS_TASK_DEFINITION=arbor-agent:1,
    SUBNET_IDS=${PRIVATE_SUBNET_A},${PRIVATE_SUBNET_B},
    SECURITY_GROUP_IDS=${APP_SG},
    ADMIN_USER_IDS=${ADMIN_USER_IDS},
    DATABASE_URL=$(aws secretsmanager get-secret-value --secret-id arbor/database-url --query SecretString --output text),
    SLACK_SIGNING_SECRET=$(aws secretsmanager get-secret-value --secret-id arbor/slack-signing-secret --query SecretString --output text)
  }"

echo "--- 8. API Gateway ---"

API_ID=$(aws apigatewayv2 create-api \
  --name arbor \
  --protocol-type HTTP \
  --query ApiId --output text)

aws lambda add-permission \
  --function-name arbor-webhook \
  --statement-id apigateway-invoke \
  --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:${AWS_REGION}:${AWS_ACCOUNT_ID}:${API_ID}/*"

INTEGRATION_ID=$(aws apigatewayv2 create-integration \
  --api-id "$API_ID" \
  --integration-type AWS_PROXY \
  --integration-uri "$LAMBDA_ARN" \
  --payload-format-version 2.0 \
  --query IntegrationId --output text)

aws apigatewayv2 create-route \
  --api-id "$API_ID" \
  --route-key "POST /slack/events" \
  --target "integrations/${INTEGRATION_ID}"

aws apigatewayv2 create-route \
  --api-id "$API_ID" \
  --route-key "POST /slack/commands" \
  --target "integrations/${INTEGRATION_ID}"

aws apigatewayv2 create-stage \
  --api-id "$API_ID" \
  --stage-name '$default' \
  --auto-deploy

API_URL="https://${API_ID}.execute-api.${AWS_REGION}.amazonaws.com"

echo ""
echo "============================================================"
echo "Setup complete."
echo "API Gateway URL: $API_URL"
echo ""
echo "Next steps:"
echo "  1. Create the url_config table in your database (see §2.3 above)"
echo "  2. Configure your Slack app — use the URL above:"
echo "       Events:   ${API_URL}/slack/events"
echo "       Commands: ${API_URL}/slack/commands"
echo "  3. Run the smoke test below to verify the deployment"
echo "============================================================"
```

---

## Slack App Configuration

These steps are done in the [Slack API console](https://api.slack.com/apps) — they cannot be scripted.

1. **Event Subscriptions** → enable, set Request URL to `<API_URL>/slack/events`, subscribe to the `app_mention` bot event.
2. **Slash Commands** → create `/squirrel-admin`, set Request URL to `<API_URL>/slack/commands`.
3. **OAuth & Permissions** → add bot token scopes: `app_mentions:read`, `chat:write`, `conversations:history`, `conversations:replies`.
4. Install the app to your workspace and copy the bot token into the `arbor/slack-bot-token` secret (update it if it changed since you ran the script).
5. Copy the Signing Secret from **Basic Information** into `arbor/slack-signing-secret`.
6. Invite `@Squirrel` to the channels where you want to use it.

---

## Smoke Test

```bash
# Replace with the API_URL printed at the end of the setup script
API_URL="https://<your-api-id>.execute-api.<region>.amazonaws.com"

# Should return 401 — confirms Lambda is reachable and signature verification works
curl -s -o /dev/null -w "%{http_code}" -X POST "${API_URL}/slack/events" \
  -H "Content-Type: application/json" \
  -H "x-slack-request-timestamp: $(date +%s)" \
  -H "x-slack-signature: v0=badhash" \
  -d '{}'
# Expected output: 401

# After mentioning @Squirrel in Slack, verify the ECS task started
aws ecs list-tasks --cluster arbor --family arbor-agent --desired-status RUNNING
```
