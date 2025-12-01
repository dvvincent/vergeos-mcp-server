#!/bin/bash
#
# Deploy VergeOS MCP Server to Kubernetes
#

set -e

NAMESPACE="${VERGEOS_MCP_NAMESPACE:-vergeos-mcp}"
DOMAIN="${VERGEOS_MCP_DOMAIN:-vergeos-mcp.example.com}"
TLS_SECRET="${VERGEOS_MCP_TLS_SECRET:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=========================================="
echo "Deploying VergeOS MCP Server to Kubernetes"
echo "=========================================="
echo ""

# Load credentials from .env or environment
if [ -f "${SCRIPT_DIR}/.env" ]; then
    source "${SCRIPT_DIR}/.env"
elif [ -f ~/.vergeos-credentials ]; then
    source ~/.vergeos-credentials
fi

# Verify required variables
if [ -z "${VERGEOS_HOST}" ] || [ -z "${VERGEOS_USER}" ] || [ -z "${VERGEOS_PASS}" ]; then
    echo "Error: Missing required environment variables"
    echo "Set VERGEOS_HOST, VERGEOS_USER, and VERGEOS_PASS in .env or environment"
    exit 1
fi

# Create namespace
echo "1. Creating namespace..."
kubectl create namespace ${NAMESPACE} --dry-run=client -o yaml | kubectl apply -f -

# Create secret with credentials
echo "2. Creating credentials secret..."
kubectl create secret generic vergeos-credentials \
    --namespace=${NAMESPACE} \
    --from-literal=VERGEOS_HOST="${VERGEOS_HOST}" \
    --from-literal=VERGEOS_USER="${VERGEOS_USER}" \
    --from-literal=VERGEOS_PASS="${VERGEOS_PASS}" \
    --dry-run=client -o yaml | kubectl apply -f -

# Create ConfigMap for source code
echo "3. Creating source ConfigMap..."
kubectl create configmap vergeos-mcp-source \
    --namespace=${NAMESPACE} \
    --from-file=http-server.js="${SCRIPT_DIR}/src/http-server.js" \
    --dry-run=client -o yaml | kubectl apply -f -

# Create ConfigMap for package.json
echo "4. Creating package.json ConfigMap..."
kubectl create configmap vergeos-mcp-package \
    --namespace=${NAMESPACE} \
    --from-file=package.json="${SCRIPT_DIR}/package.json" \
    --dry-run=client -o yaml | kubectl apply -f -

# Copy TLS secret if specified and exists in another namespace
echo "5. Setting up TLS..."
if [ -n "${TLS_SECRET}" ] && [ -n "${TLS_SECRET_SOURCE_NS}" ]; then
    if kubectl get secret ${TLS_SECRET} -n ${TLS_SECRET_SOURCE_NS} &>/dev/null; then
        kubectl get secret ${TLS_SECRET} -n ${TLS_SECRET_SOURCE_NS} -o yaml | \
            sed "s/namespace: ${TLS_SECRET_SOURCE_NS}/namespace: ${NAMESPACE}/" | \
            kubectl apply -f -
        echo "   Copied TLS secret from ${TLS_SECRET_SOURCE_NS}"
    else
        echo "   Warning: TLS secret ${TLS_SECRET} not found in ${TLS_SECRET_SOURCE_NS}"
    fi
else
    echo "   Skipping TLS setup (set TLS_SECRET and TLS_SECRET_SOURCE_NS to enable)"
fi

# Apply deployment
echo "6. Applying deployment..."
cat <<EOF | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vergeos-mcp
  namespace: ${NAMESPACE}
  labels:
    app: vergeos-mcp
spec:
  replicas: 1
  selector:
    matchLabels:
      app: vergeos-mcp
  template:
    metadata:
      labels:
        app: vergeos-mcp
    spec:
      containers:
      - name: vergeos-mcp
        image: node:20-alpine
        ports:
        - containerPort: 3002
          name: http
        env:
        - name: PORT
          value: "3002"
        - name: VERGEOS_HOST
          valueFrom:
            secretKeyRef:
              name: vergeos-credentials
              key: VERGEOS_HOST
        - name: VERGEOS_USER
          valueFrom:
            secretKeyRef:
              name: vergeos-credentials
              key: VERGEOS_USER
        - name: VERGEOS_PASS
          valueFrom:
            secretKeyRef:
              name: vergeos-credentials
              key: VERGEOS_PASS
        command:
        - sh
        - -c
        - |
          cd /app
          npm install express cors node-fetch dotenv
          node src/http-server.js
        workingDir: /app
        volumeMounts:
        - name: app-source
          mountPath: /app/src
        - name: package-json
          mountPath: /app/package.json
          subPath: package.json
        resources:
          requests:
            cpu: 50m
            memory: 128Mi
          limits:
            cpu: 200m
            memory: 256Mi
        livenessProbe:
          httpGet:
            path: /health
            port: 3002
          initialDelaySeconds: 60
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health
            port: 3002
          initialDelaySeconds: 30
          periodSeconds: 5
      volumes:
      - name: app-source
        configMap:
          name: vergeos-mcp-source
      - name: package-json
        configMap:
          name: vergeos-mcp-package
EOF

# Apply service
echo "7. Creating service..."
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Service
metadata:
  name: vergeos-mcp
  namespace: ${NAMESPACE}
spec:
  selector:
    app: vergeos-mcp
  ports:
  - port: 3002
    targetPort: 3002
    name: http
  type: ClusterIP
EOF

# Apply IngressRoute (Traefik)
echo "8. Creating IngressRoute..."
if [ -n "${TLS_SECRET}" ]; then
cat <<EOF | kubectl apply -f -
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: vergeos-mcp
  namespace: ${NAMESPACE}
spec:
  entryPoints:
    - websecure
  routes:
    - match: Host(\`${DOMAIN}\`)
      kind: Rule
      services:
        - name: vergeos-mcp
          port: 3002
  tls:
    secretName: ${TLS_SECRET}
EOF
else
cat <<EOF | kubectl apply -f -
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: vergeos-mcp
  namespace: ${NAMESPACE}
spec:
  entryPoints:
    - web
  routes:
    - match: Host(\`${DOMAIN}\`)
      kind: Rule
      services:
        - name: vergeos-mcp
          port: 3002
EOF
fi

# Wait for deployment
echo ""
echo "9. Waiting for deployment to be ready..."
kubectl rollout status deployment/vergeos-mcp -n ${NAMESPACE} --timeout=120s

# Show status
echo ""
echo "=========================================="
echo "Deployment Complete!"
echo "=========================================="
echo ""
echo "Pod status:"
kubectl get pods -n ${NAMESPACE}
echo ""
echo "Service:"
kubectl get svc -n ${NAMESPACE}
echo ""
PROTOCOL="http"
[ -n "${TLS_SECRET}" ] && PROTOCOL="https"
echo "Access URL: ${PROTOCOL}://${DOMAIN}"
echo ""
echo "Test with:"
echo "  curl ${PROTOCOL}://${DOMAIN}/health"
echo "  curl ${PROTOCOL}://${DOMAIN}/vms"
echo ""
