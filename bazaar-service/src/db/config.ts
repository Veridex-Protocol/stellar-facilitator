/**
 * Veridex Bazaar Discovery Engine - Database Configuration
 * License: Apache-2.0
 *
 * PostgreSQL connection management with pgvector support.
 * Provides connection pooling and query utilities.
 */

import pkg from "pg";
const { Pool } = pkg;
import type { Pool as PoolType, QueryResult, QueryResultRow } from "pg";

/**
 * Database configuration interface
 */
export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
  maxConnections?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

/**
 * Default database configuration from environment variables
 */
export function getDefaultConfig(): DatabaseConfig {
  return {
    host: process.env.DATABASE_HOST || "localhost",
    port: parseInt(process.env.DATABASE_PORT || "5432", 10),
    database: process.env.DATABASE_NAME || "veridex_bazaar",
    user: process.env.DATABASE_USER || "postgres",
    password: process.env.DATABASE_PASSWORD || "",
    ssl: process.env.DATABASE_SSL === "true",
    maxConnections: parseInt(process.env.DATABASE_MAX_CONNECTIONS || "20", 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  };
}

/**
 * Database connection pool manager
 * Singleton pattern for application-wide pool
 */
export class Database {
  private static instance: Database | null = null;
  private pool: PoolType;
  private config: DatabaseConfig;

  private constructor(config: DatabaseConfig) {
    this.config = config;
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      max: config.maxConnections,
      idleTimeoutMillis: config.idleTimeoutMillis,
      connectionTimeoutMillis: config.connectionTimeoutMillis,
    });

    // Error handler for unexpected pool errors
    this.pool.on("error", (err) => {
      console.error("[Database] Unexpected error on idle client:", err);
    });
  }

  /**
   * Get singleton database instance
   */
  public static getInstance(config?: DatabaseConfig): Database {
    if (!Database.instance) {
      Database.instance = new Database(config || getDefaultConfig());
    }
    return Database.instance;
  }

  /**
   * Get the underlying pg.Pool instance
   */
  public getPool(): PoolType {
    return this.pool;
  }

  /**
   * Execute a query with parameters
   */
  public async query<T extends QueryResultRow = any>(
    text: string,
    params?: any[]
  ): Promise<QueryResult<T>> {
    const start = Date.now();
    try {
      const result = await this.pool.query<T>(text, params);
      const duration = Date.now() - start;

      if (duration > 1000) {
        console.warn(`[Database] Slow query (${duration}ms):`, text.substring(0, 100));
      }

      return result;
    } catch (error) {
      console.error("[Database] Query error:", error);
      console.error("[Database] Query:", text);
      console.error("[Database] Params:", params);
      throw error;
    }
  }

  /**
   * Execute a query within a transaction
   */
  public async transaction<T>(
    callback: (client: any) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Check database connection and extensions
   */
  public async healthCheck(): Promise<{
    connected: boolean;
    extensions: string[];
    error?: string;
  }> {
    try {
      // Test connection
      await this.pool.query("SELECT 1");

      // Check required extensions
      const result = await this.pool.query<{ extname: string }>(
        "SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pg_trgm')"
      );

      const extensions = result.rows.map((row) => row.extname);
      const hasVector = extensions.includes("vector");
      const hasTrgm = extensions.includes("pg_trgm");

      if (!hasVector || !hasTrgm) {
        return {
          connected: true,
          extensions,
          error: `Missing required extensions. Found: ${extensions.join(", ")}`,
        };
      }

      return {
        connected: true,
        extensions,
      };
    } catch (error) {
      return {
        connected: false,
        extensions: [],
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Initialize database schema
   * Reads and executes schema.sql file
   */
  public async initializeSchema(schemaPath: string): Promise<void> {
    const fs = await import("fs/promises");
    const schema = await fs.readFile(schemaPath, "utf-8");

    await this.pool.query(schema);
    console.log("[Database] Schema initialized successfully");
  }

  /**
   * Close database connection pool
   */
  public async close(): Promise<void> {
    await this.pool.end();
    console.log("[Database] Connection pool closed");
    Database.instance = null;
  }

  /**
   * Get pool statistics
   */
  public getStats(): {
    totalCount: number;
    idleCount: number;
    waitingCount: number;
  } {
    return {
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount,
    };
  }
}

/**
 * Helper to create a database instance with config
 */
export function createDatabase(config?: Partial<DatabaseConfig>): Database {
  const fullConfig = { ...getDefaultConfig(), ...config };
  return Database.getInstance(fullConfig);
}
