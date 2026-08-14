#!/bin/bash
# Veridex Bazaar - Database Initialization Script
# License: Apache-2.0

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "=========================================="
echo "Veridex Bazaar - Database Initialization"
echo "=========================================="
echo ""

# Load environment variables if .env exists
if [ -f .env ]; then
  echo "📄 Loading environment from .env..."
  export $(grep -v '^#' .env | xargs)
fi

# Database configuration
DB_HOST=${DATABASE_HOST:-localhost}
DB_PORT=${DATABASE_PORT:-5432}
DB_NAME=${DATABASE_NAME:-veridex_bazaar}
DB_USER=${DATABASE_USER:-postgres}
DB_PASSWORD=${DATABASE_PASSWORD:-}

echo "Database Configuration:"
echo "  Host: $DB_HOST"
echo "  Port: $DB_PORT"
echo "  Database: $DB_NAME"
echo "  User: $DB_USER"
echo ""

# Check if PostgreSQL is accessible
echo "🔍 Checking PostgreSQL connection..."
if ! PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -p $DB_PORT -U $DB_USER -c '\q' 2>/dev/null; then
  echo -e "${RED}❌ Cannot connect to PostgreSQL${NC}"
  echo "Please ensure PostgreSQL is running and credentials are correct."
  exit 1
fi
echo -e "${GREEN}✓ PostgreSQL connection successful${NC}"
echo ""

# Check if database exists
echo "🔍 Checking if database '$DB_NAME' exists..."
if PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -p $DB_PORT -U $DB_USER -lqt | cut -d \| -f 1 | grep -qw $DB_NAME; then
  echo -e "${YELLOW}⚠ Database '$DB_NAME' already exists${NC}"
  read -p "Do you want to recreate it? This will delete all data! (yes/no): " -r
  echo
  if [[ $REPLY == "yes" ]]; then
    echo "🗑️  Dropping existing database..."
    PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -p $DB_PORT -U $DB_USER -c "DROP DATABASE $DB_NAME;"
    echo "📦 Creating database..."
    PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -p $DB_PORT -U $DB_USER -c "CREATE DATABASE $DB_NAME;"
    echo -e "${GREEN}✓ Database recreated${NC}"
  else
    echo "Using existing database..."
  fi
else
  echo "📦 Creating database '$DB_NAME'..."
  PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -p $DB_PORT -U $DB_USER -c "CREATE DATABASE $DB_NAME;"
  echo -e "${GREEN}✓ Database created${NC}"
fi
echo ""

# Install pgvector extension
echo "📦 Installing pgvector extension..."
PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>/dev/null || {
  echo -e "${RED}❌ Failed to install pgvector extension${NC}"
  echo "Please install pgvector: https://github.com/pgvector/pgvector"
  exit 1
}
echo -e "${GREEN}✓ pgvector extension installed${NC}"
echo ""

# Run schema migrations
echo "📄 Running schema migrations..."
SCHEMA_FILE="./src/db/schema.sql"

if [ ! -f "$SCHEMA_FILE" ]; then
  echo -e "${RED}❌ Schema file not found: $SCHEMA_FILE${NC}"
  exit 1
fi

PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -f $SCHEMA_FILE

if [ $? -eq 0 ]; then
  echo -e "${GREEN}✓ Schema migrations completed${NC}"
else
  echo -e "${RED}❌ Schema migrations failed${NC}"
  exit 1
fi
echo ""

# Verify tables
echo "🔍 Verifying tables..."
TABLE_COUNT=$(PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';")

if [ $TABLE_COUNT -ge 3 ]; then
  echo -e "${GREEN}✓ Found $TABLE_COUNT tables${NC}"
  echo ""
  echo "Tables created:"
  PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -c "\dt"
else
  echo -e "${RED}❌ Expected at least 3 tables, found $TABLE_COUNT${NC}"
  exit 1
fi
echo ""

# Verify pgvector
echo "🔍 Verifying pgvector extension..."
VECTOR_VERSION=$(PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -t -c "SELECT extversion FROM pg_extension WHERE extname = 'vector';")

if [ ! -z "$VECTOR_VERSION" ]; then
  echo -e "${GREEN}✓ pgvector version: $VECTOR_VERSION${NC}"
else
  echo -e "${RED}❌ pgvector extension not found${NC}"
  exit 1
fi
echo ""

echo "=========================================="
echo -e "${GREEN}✅ Database initialization complete!${NC}"
echo "=========================================="
echo ""
echo "Connection string:"
echo "  postgresql://$DB_USER:****@$DB_HOST:$DB_PORT/$DB_NAME"
echo ""
echo "Next steps:"
echo "  1. Update your .env file with the database credentials"
echo "  2. Run: npm start"
echo ""
