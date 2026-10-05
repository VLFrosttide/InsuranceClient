-- Migration: Create broker_pricing table
-- Description: Creates a new table to store pricing for each broker by vehicle type and duration
-- Date: 2026-10-05

-- Create the broker_pricing table
CREATE TABLE IF NOT EXISTS broker_pricing (
  id INT PRIMARY KEY AUTO_INCREMENT,
  broker_id INT NOT NULL,
  vehicle_type VARCHAR(100) NOT NULL COMMENT 'e.g., Auto, Motor, Bus, Trailer',
  duration INT NOT NULL COMMENT 'Duration in days (15, 30, 90)',
  price DECIMAL(10, 2) NOT NULL COMMENT 'Price with up to 2 decimal places',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (broker_id) REFERENCES brokers(id) ON DELETE CASCADE,
  UNIQUE KEY unique_broker_vehicle_duration (broker_id, vehicle_type, duration),
  INDEX idx_broker_id (broker_id),
  INDEX idx_vehicle_duration (vehicle_type, duration)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='Stores pricing for each broker by vehicle type and duration';

-- Add indexes for common queries
CREATE INDEX idx_broker_vehicle ON broker_pricing(broker_id, vehicle_type);
CREATE INDEX idx_broker_duration ON broker_pricing(broker_id, duration);

-- Verify table was created
SHOW CREATE TABLE broker_pricing;
