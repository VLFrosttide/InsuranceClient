# Broker Pricing API Implementation Guide

## Overview

This document describes the server-side API endpoints needed to support the broker pricing editor feature in the admin dashboard.

## Features Implemented (Frontend)

- Added "View/Edit Pricing" button to broker actions table
- Modal form displays all vehicle types and durations for a broker
- Editable price inputs for each vehicle type/duration combination
- Submit button to save changes to the server

## Required API Endpoints

### 1. Get Broker Pricing

**Endpoint:** `GET /brokers/{brokerId}/pricing`

**Description:** Retrieves all pricing for a specific broker across all vehicle types and durations.

**Authentication:** Required (Bearer token)

**Response:**

```json
{
  "pricing": {
    "Auto": {
      "15": 25.0,
      "30": 45.0,
      "90": 120.0
    },
    "Motor": {
      "15": 20.0,
      "30": 38.0,
      "90": 100.0
    },
    "Bus": {
      "15": 35.0,
      "30": 65.0,
      "90": 180.0
    },
    "Trailer": {
      "15": 18.0,
      "30": 33.0,
      "90": 90.0
    }
  }
}
```

**Error Responses:**

- `404`: Broker not found
- `401`: Unauthorized
- `403`: Forbidden (user doesn't have permission to view this broker)

---

### 2. Update Broker Pricing

**Endpoint:** `PUT /brokers/{brokerId}/pricing`

**Description:** Updates pricing for a specific broker. Accepts a pricing object with all vehicle types and durations.

**Authentication:** Required (Bearer token, admin only)

**Request Body:**

```json
{
  "pricing": {
    "Auto": {
      "15": 25.5,
      "30": 45.5,
      "90": 120.5
    },
    "Motor": {
      "15": 20.5,
      "30": 38.5,
      "90": 100.5
    },
    "Bus": {
      "15": 35.5,
      "30": 65.5,
      "90": 180.5
    },
    "Trailer": {
      "15": 18.5,
      "30": 33.5,
      "90": 90.5
    }
  }
}
```

**Response:**

```json
{
  "success": true,
  "message": "Pricing updated successfully",
  "pricing": {
    "Auto": {
      "15": 25.50,
      "30": 45.50,
      "90": 120.50
    },
    ...
  }
}
```

**Error Responses:**

- `400`: Bad request (invalid pricing format)
- `404`: Broker not found
- `401`: Unauthorized
- `403`: Forbidden (only admins can update pricing)

---

## Data Structure

### Pricing Object Format

The pricing object follows this structure:

- **Key:** Vehicle type (string) - e.g., "Auto", "Motor", "Bus", "Trailer"
- **Value:** Object with duration keys (string representation of days)
  - **Duration Keys:** "15", "30", "90" (string representation of days)
  - **Duration Values:** Number (price as decimal with up to 2 decimal places)

### Example Structure in Code:

```javascript
{
  "Auto": { "15": 25.00, "30": 45.00, "90": 120.00 },
  "Motor": { "15": 20.00, "30": 38.00, "90": 100.00 },
  "Bus": { "15": 35.00, "30": 65.00, "90": 180.00 },
  "Trailer": { "15": 18.00, "30": 33.00, "90": 90.00 }
}
```

## Database Changes

### Suggested Table Structure

Create a new table `broker_pricing` or extend existing broker-related tables:

```sql
CREATE TABLE broker_pricing (
  id INT PRIMARY KEY AUTO_INCREMENT,
  broker_id INT NOT NULL,
  vehicle_type VARCHAR(50) NOT NULL,
  duration INT NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (broker_id) REFERENCES brokers(id) ON DELETE CASCADE,
  UNIQUE KEY unique_broker_vehicle_duration (broker_id, vehicle_type, duration),
  INDEX idx_broker_id (broker_id)
);
```

Alternatively, you could store pricing as a JSON field in the brokers table if using MySQL 5.7+.

## Implementation Notes

1. **Validation:**

   - Ensure only admins can modify broker pricing
   - Validate that all required vehicle types and durations are present
   - Validate that prices are non-negative decimal numbers
   - Check that broker_id exists before updating

2. **Authorization:**

   - GET endpoint: Any authenticated user can view their own or assigned broker pricing
   - PUT endpoint: Only admins (role 1) can update pricing

3. **Error Handling:**

   - Return meaningful error messages
   - Log pricing updates for audit purposes
   - Handle concurrent updates appropriately

4. **Integration:**
   - The frontend already caches pricing from `/tariffs/my-pricing` endpoint
   - Consider updating or invalidating the cache when pricing changes
   - Ensure consistency between broker-specific pricing and global tariffs

## Frontend Usage

The frontend calls these endpoints when:

1. Admin clicks "View/Edit Pricing" button on a broker row
2. Admin modifies price values in the modal form
3. Admin clicks the "Save" button to submit changes

The modal displays prices in a table format with:

- Rows: Vehicle types
- Columns: Durations (15 days, 30 days, 90 days)
- Cells: Editable number inputs for prices

## Testing Checklist

- [ ] GET endpoint returns correct pricing structure
- [ ] PUT endpoint accepts and saves pricing updates
- [ ] Prices are validated and stored with 2 decimal precision
- [ ] Only admins can update pricing
- [ ] 404 errors returned for non-existent brokers
- [ ] Concurrent updates handled correctly
- [ ] Frontend success toast appears after update
- [ ] Broker view refreshes after pricing update
