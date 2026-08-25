# Bazaar Service - Database Setup Guide

**License:** Apache-2.0  
**Database:** PostgreSQL 15+ with pgvector extension

---

## Prerequisites

### 1. Install PostgreSQL 15+

**macOS (Homebrew):**
```bash
brew install postgresql@16
brew services start postgresql@16
```

**Ubuntu/Debian:**
```bash
sudo apt-get update
sudo apt-get install postgresql-16
sudo systemctl start postgresql
```

**Docker:**
```bash
docker run -d \
  --name veridex-postgres \
  -e POSTGRES_PASSWORD=yourpassword \
  -p 5432:5432 \
  pgvector/pgvector:pg16
```

### 2. Install pgvector Extension

**From Source:**
```bash
git clone https://github.com/pgvector/pgvector.git
cd pgvector
make
sudo make install
```

**Using Docker:**
The `pgvector/pgvector:pg16` image includes pgvector pre-installed.

---

## Quick Setup (Automated)

### Option 1: Run Initialization Script

```bash
cd bazaar-service
chmod +x scripts/init-db.sh
./scripts/init-db.sh
```

The script will:
1. Check PostgreSQL connection
2. Create `veridex_bazaar` database
3. Install pgvector extension
4. Run schema migrations
5. Verify tables and indexes

### Option 2: Manual Setup

```bash
# 1. Create database
createdb veridex_bazaar

# 2. Run schema
psql -d veridex_bazaar -f src/db/schema.sql

# 3. Verify
psql -d veridex_bazaar -c "\dt"
```

---

## Environment Configuration

Create `.env` in `bazaar-service/`:

```bash
# Database Configuration
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_NAME=veridex_bazaar
DATABASE_USER=postgres
DATABASE_PASSWORD=yourpassword

# P2P Configuration
P2P_LISTEN_ADDRS=/ip4/0.0.0.0/tcp/4001
P2P_BOOTSTRAP_PEERS=

# Bazaar Service
BAZAAR_PORT=3001
BAZAAR_HOST=0.0.0.0
```

---

## Schema Overview

### Tables

**1. `catalog_resources`** - Primary catalog
- Stores HTTP endpoints and MCP tools
- Includes 384-dim vector embeddings
- Compound unique constraint on `(resource_url, tool_name)`

**2. `resource_telemetry`** - Real-time metrics
- Tracks uptime, latency, settlement success
- Foreign key to `catalog_resources`
- Used for composite ranking

**3. `node_heartbeats`** - P2P audit log
- Signed heartbeat messages
- Used for 30-day uptime calculation

### Indexes

**Vector Search (IVFFlat):**
```sql
CREATE INDEX idx_catalog_resources_embedding 
ON catalog_resources USING ivfflat (embedding vector_cosine_ops);
```

**Full-Text Search (GIN + trigram):**
```sql
CREATE INDEX idx_catalog_resources_text 
ON catalog_resources USING gin (to_tsvector('english', description || ' ' || COALESCE(service_name, '')));
```

**Filter Composite:**
```sql
CREATE INDEX idx_catalog_resources_filter 
ON catalog_resources (network, scheme, soft_dropped);
```

---

## Verification

### Check Tables
```bash
psql -d veridex_bazaar -c "\dt"
```

Expected output:
```
                  List of relations
 Schema |       Name        | Type  |  Owner   
--------+-------------------+-------+----------
 public | catalog_resources | table | postgres
 public | node_heartbeats   | table | postgres
 public | resource_telemetry| table | postgres
```

### Check Extensions
```bash
psql -d veridex_bazaar -c "\dx"
```

Should include:
- `vector` (pgvector)
- `pg_trgm` (trigram for fuzzy search)

### Check Indexes
```bash
psql -d veridex_bazaar -c "\di"
```

Should show 5+ indexes including IVFFlat vector index.

---

## Troubleshooting

### Error: "extension vector does not exist"

**Solution:** Install pgvector:
```bash
# macOS
brew install pgvector

# Ubuntu
sudo apt-get install postgresql-16-pgvector

# From source
git clone https://github.com/pgvector/pgvector.git
cd pgvector && make && sudo make install
```

### Error: "could not connect to server"

**Check PostgreSQL is running:**
```bash
# macOS
brew services list | grep postgresql

# Linux
sudo systemctl status postgresql

# Docker
docker ps | grep postgres
```

### Error: "permission denied for database"

**Grant permissions:**
```bash
psql -c "GRANT ALL PRIVILEGES ON DATABASE veridex_bazaar TO your_user;"
```

### Slow Vector Queries

**Tune IVFFlat lists parameter:**
```sql
-- For ~1000 resources
DROP INDEX idx_catalog_resources_embedding;
CREATE INDEX idx_catalog_resources_embedding 
ON catalog_resources USING ivfflat (embedding vector_cosine_ops) 
WITH (lists = 10);

-- For ~10,000 resources
-- lists = 100

-- For ~100,000+ resources  
-- lists = 1000
```

**Rule of thumb:** `lists = sqrt(total_rows)`

---

## Database Maintenance

### Backup
```bash
pg_dump veridex_bazaar > backup_$(date +%Y%m%d).sql
```

### Restore
```bash
psql -d veridex_bazaar < backup_20260809.sql
```

### Reset Database
```bash
dropdb veridex_bazaar
createdb veridex_bazaar
psql -d veridex_bazaar -f src/db/schema.sql
```

### Vacuum (Performance)
```bash
psql -d veridex_bazaar -c "VACUUM ANALYZE catalog_resources;"
```

---

## Performance Tuning

### PostgreSQL Configuration

Add to `postgresql.conf`:

```conf
# Shared memory for vector operations
shared_buffers = 256MB

# Increase work memory for vector operations
work_mem = 64MB

# Max connections
max_connections = 100

# Enable statistics for query optimization
shared_preload_libraries = 'pg_stat_statements'
```

Restart PostgreSQL after changes.

### Query Performance

**Check slow queries:**
```sql
SELECT query, mean_exec_time, calls
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 10;
```

---

## Production Deployment

### RDS (AWS)
1. Create PostgreSQL 16 instance
2. Enable pgvector extension: `CREATE EXTENSION vector;`
3. Run schema migrations
4. Configure security groups (port 5432)
5. Use SSL connection string

### Cloud SQL (GCP)
1. Create PostgreSQL 16 instance
2. Install pgvector extension
3. Configure authorized networks
4. Use Cloud SQL Proxy for secure connections

### Azure Database for PostgreSQL
1. Create Flexible Server (PostgreSQL 16)
2. Install pgvector extension
3. Configure firewall rules
4. Use SSL-enforced connections

---

## Support

- **Issues:** https://github.com/veridex-protocol/veridex/issues
- **pgvector Docs:** https://github.com/pgvector/pgvector
- **PostgreSQL Docs:** https://www.postgresql.org/docs/16/

---

*Last Updated: August 9, 2026*
