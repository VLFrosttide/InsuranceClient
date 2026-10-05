-- Migration: Insert sample broker pricing data
-- Description: Populates initial pricing data for testing the broker pricing editor
-- Date: 2026-10-05
-- Note: Adjust broker_id values based on your actual broker records

-- Insert sample pricing for all brokers
-- Assuming brokers with IDs 1, 2, 3, etc. exist

-- Sample data for Broker ID 1
INSERT INTO broker_pricing (broker_id, vehicle_type, duration, price) VALUES
  (1, 'Auto', 15, 25.00),
  (1, 'Auto', 30, 45.00),
  (1, 'Auto', 90, 120.00),
  (1, 'Motor', 15, 20.00),
  (1, 'Motor', 30, 38.00),
  (1, 'Motor', 90, 100.00),
  (1, 'Bus', 15, 35.00),
  (1, 'Bus', 30, 65.00),
  (1, 'Bus', 90, 180.00),
  (1, 'Trailer', 15, 18.00),
  (1, 'Trailer', 30, 33.00),
  (1, 'Trailer', 90, 90.00)
ON DUPLICATE KEY UPDATE
  price = VALUES(price),
  updated_at = NOW();

-- Sample data for Broker ID 2 (if exists)
INSERT INTO broker_pricing (broker_id, vehicle_type, duration, price) VALUES
  (2, 'Auto', 15, 24.00),
  (2, 'Auto', 30, 43.00),
  (2, 'Auto', 90, 115.00),
  (2, 'Motor', 15, 19.00),
  (2, 'Motor', 30, 36.00),
  (2, 'Motor', 90, 95.00),
  (2, 'Bus', 15, 34.00),
  (2, 'Bus', 30, 63.00),
  (2, 'Bus', 90, 175.00),
  (2, 'Trailer', 15, 17.00),
  (2, 'Trailer', 30, 31.00),
  (2, 'Trailer', 90, 85.00)
ON DUPLICATE KEY UPDATE
  price = VALUES(price),
  updated_at = NOW();

-- Sample data for Broker ID 3 (if exists)
INSERT INTO broker_pricing (broker_id, vehicle_type, duration, price) VALUES
  (3, 'Auto', 15, 26.00),
  (3, 'Auto', 30, 47.00),
  (3, 'Auto', 90, 125.00),
  (3, 'Motor', 15, 21.00),
  (3, 'Motor', 30, 40.00),
  (3, 'Motor', 90, 105.00),
  (3, 'Bus', 15, 36.00),
  (3, 'Bus', 30, 67.00),
  (3, 'Bus', 90, 185.00),
  (3, 'Trailer', 15, 19.00),
  (3, 'Trailer', 30, 35.00),
  (3, 'Trailer', 90, 95.00)
ON DUPLICATE KEY UPDATE
  price = VALUES(price),
  updated_at = NOW();

-- Verify data insertion
SELECT broker_id, vehicle_type, duration, price, created_at, updated_at
FROM broker_pricing
ORDER BY broker_id, vehicle_type, duration;
