import { Sequelize } from "sequelize-typescript";
import "dotenv/config";
import { Entities } from "..";

export const Connection = [
  {
    provide: "SEQUELIZE",
    useFactory: async () => {
      const sequelize = new Sequelize({
        dialect: process.env.DATABASE_TYPE as "postgres" | "mysql",
        database: process.env.DATABASE_NAME,
        username: process.env.DATABASE_USERNAME,
        password: process.env.DATABASE_PASSWORD,
        port: Number(process.env.DATABASE_PORT || 5432),
        // Every SQL statement to stdout. Fine on a dev box; on Cloud Run each line is a
        // billed log entry, and one Meta content snapshot alone issues tens of thousands
        // of statements. Set DATABASE_QUERY_LOGGING=false there. Default stays on so no
        // existing environment changes behaviour until it opts out.
        logging: process.env.DATABASE_QUERY_LOGGING !== "false",
        models: Entities,

        pool: {
          max: Number(process.env.MAX_DB_CONNECTIONS || 10),
          min: Number(process.env.MIN_DB_CONNECTIONS || 5),
          acquire: 60000,
          idle: 10000,
          evict: 5000,
        },

        // IMPORTANT: required for Postgres servers expecting encrypted connections
        dialectOptions:
          process.env.DATABASE_TYPE === "postgres"
            ? {
                ssl:
                  process.env.DB_SSL === "true"
                    ? {
                        require: true,
                        // Defaults to strict certificate validation. Only disable via the
                        // explicit opt-out below for environments that require self-signed
                        // certs (e.g. some managed Postgres providers' internal networking).
                        rejectUnauthorized:
                          process.env.DB_SSL_ALLOW_SELF_SIGNED === "true" ? false : true,
                      }
                    : false,
              }
            : {},

        replication: {
          read: [
            {
              host: process.env.READ_DATABASE_HOST,
              username: process.env.DATABASE_USERNAME,
              password: process.env.DATABASE_PASSWORD,
              database: process.env.DATABASE_NAME,
              port: Number(process.env.DATABASE_PORT || 5432),
            },
          ],
          write: {
            host: process.env.WRITE_DATABASE_HOST,
            username: process.env.DATABASE_USERNAME,
            password: process.env.DATABASE_PASSWORD,
            database: process.env.DATABASE_NAME,
            port: Number(process.env.DATABASE_PORT || 5432),
          },
        },
      });

      try {
        await sequelize.authenticate();
        console.log("✅ Database connected successfully");
      } catch (error) {
        console.error("❌ Database connection failed:", error);
        throw error;
      }

      return sequelize;
    },
  },
];