/**
 * Broker Pricing Routes for Express.js
 *
 * Add these routes to your Express app to support the broker pricing editor.
 * The frontend calls:
 *   GET /brokers/:brokerId/pricing
 *   PUT /brokers/:brokerId/pricing
 */

/**
 * GET /brokers/:brokerId/pricing
 *
 * Retrieves all pricing for a specific broker
 *
 * Response:
 * {
 *   "success": true,
 *   "pricing": {
 *     "Auto": { "15": 25.0, "30": 45.0, "90": 120.0 },
 *     "Motor": { "15": 20.0, "30": 38.0, "90": 100.0 }
 *   }
 * }
 */
async function getBrokerPricing(req, res) {
  try {
    const brokerId = req.params.brokerId;

    // Validate broker ID
    if (!brokerId || isNaN(brokerId) || Number(brokerId) <= 0) {
      return res.status(400).json({
        success: false,
        error: "Invalid broker ID",
      });
    }

    // Get database connection from your app/request
    const db = req.app.locals.db || req.db; // Adjust based on your setup

    if (!db) {
      return res.status(500).json({
        success: false,
        error: "Database connection not available",
      });
    }

    // Check if broker exists
    const brokerCheck = await db.query("SELECT id FROM brokers WHERE id = ?", [
      brokerId,
    ]);

    if (brokerCheck.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Broker not found",
      });
    }

    // Fetch all pricing for this broker
    const rows = await db.query(
      `SELECT vehicle_type, duration, price
       FROM broker_pricing
       WHERE broker_id = ?
       ORDER BY vehicle_type, duration`,
      [brokerId]
    );

    // Structure pricing data: { vehicleType: { duration: price, ... }, ... }
    const pricing = {};
    for (const row of rows) {
      const vehicleType = row.vehicle_type;
      const duration = String(row.duration);
      const price = parseFloat(row.price);

      if (!pricing[vehicleType]) {
        pricing[vehicleType] = {};
      }
      pricing[vehicleType][duration] = price;
    }

    return res.json({
      success: true,
      pricing: pricing,
    });
  } catch (error) {
    console.error("Error fetching broker pricing:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Database error",
    });
  }
}

/**
 * PUT /brokers/:brokerId/pricing
 *
 * Updates pricing for a specific broker
 *
 * Request body:
 * {
 *   "pricing": {
 *     "Auto": { "15": 25.5, "30": 45.5, "90": 120.5 },
 *     "Motor": { "15": 20.5, "30": 38.5, "90": 100.5 }
 *   }
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "message": "Pricing updated successfully",
 *   "pricing": { ... updated pricing ... }
 * }
 */
async function updateBrokerPricing(req, res) {
  try {
    const brokerId = req.params.brokerId;
    const { pricing } = req.body;

    // Authorization check - only admins (role 1) can update pricing
    const userRole = req.user?.role || req.userRole;
    if (userRole !== 1 && userRole !== "1") {
      return res.status(403).json({
        success: false,
        error: "Unauthorized: Only admins can update pricing",
      });
    }

    // Validate broker ID
    if (!brokerId || isNaN(brokerId) || Number(brokerId) <= 0) {
      return res.status(400).json({
        success: false,
        error: "Invalid broker ID",
      });
    }

    // Validate request data
    if (!pricing || typeof pricing !== "object") {
      return res.status(400).json({
        success: false,
        error: "Invalid pricing data format",
      });
    }

    // Get database connection from your app/request
    const db = req.app.locals.db || req.db; // Adjust based on your setup

    if (!db) {
      return res.status(500).json({
        success: false,
        error: "Database connection not available",
      });
    }

    // Check if broker exists
    const brokerCheck = await db.query("SELECT id FROM brokers WHERE id = ?", [
      brokerId,
    ]);

    if (brokerCheck.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Broker not found",
      });
    }

    // Start transaction (if supported by your database library)
    let connection;
    if (db.getConnection) {
      // MySQL connection with transaction support
      connection = await db.getConnection();
      await connection.beginTransaction();
    }

    try {
      // Use connection if available, otherwise use db directly
      const queryFn = connection
        ? connection.query.bind(connection)
        : db.query.bind(db);

      // Delete existing pricing for this broker
      await queryFn("DELETE FROM broker_pricing WHERE broker_id = ?", [
        brokerId,
      ]);

      // Insert new pricing
      for (const vehicleType in pricing) {
        // Validate vehicle type
        if (typeof vehicleType !== "string" || !vehicleType.trim()) {
          throw new Error(`Invalid vehicle type: ${vehicleType}`);
        }

        const durations = pricing[vehicleType];

        // Validate durations object
        if (!durations || typeof durations !== "object") {
          throw new Error(`Invalid durations for vehicle type: ${vehicleType}`);
        }

        for (const durationStr in durations) {
          const duration = parseInt(durationStr);
          const price = parseFloat(durations[durationStr]);

          // Validate duration
          if (isNaN(duration) || duration <= 0) {
            throw new Error(`Invalid duration: ${durationStr}`);
          }

          // Validate price
          if (isNaN(price) || price < 0) {
            throw new Error(
              `Price cannot be negative for ${vehicleType} ${duration} days`
            );
          }

          // Insert pricing
          await queryFn(
            `INSERT INTO broker_pricing (broker_id, vehicle_type, duration, price)
             VALUES (?, ?, ?, ?)`,
            [brokerId, vehicleType, duration, price]
          );
        }
      }

      // Commit transaction if using connection
      if (connection && connection.commit) {
        await connection.commit();
        await connection.release();
      }

      // Fetch updated pricing to return
      const updatedRows = await db.query(
        `SELECT vehicle_type, duration, price
         FROM broker_pricing
         WHERE broker_id = ?
         ORDER BY vehicle_type, duration`,
        [brokerId]
      );

      const updatedPricing = {};
      for (const row of updatedRows) {
        const vehicleType = row.vehicle_type;
        const duration = String(row.duration);
        const price = parseFloat(row.price);

        if (!updatedPricing[vehicleType]) {
          updatedPricing[vehicleType] = {};
        }
        updatedPricing[vehicleType][duration] = price;
      }

      return res.json({
        success: true,
        message: "Pricing updated successfully",
        pricing: updatedPricing,
      });
    } catch (error) {
      // Rollback transaction if using connection
      if (connection && connection.rollback) {
        try {
          await connection.rollback();
        } catch (rollbackErr) {
          console.error("Error rolling back transaction:", rollbackErr);
        }
        await connection.release();
      }
      throw error;
    }
  } catch (error) {
    console.error("Error updating broker pricing:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Error updating pricing",
    });
  }
}

module.exports = {
  getBrokerPricing,
  updateBrokerPricing,
};
