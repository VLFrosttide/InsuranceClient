<?php
/**
 * BrokerPricingController
 *
 * API endpoints for managing broker pricing by vehicle type and duration
 */

class BrokerPricingController
{
    private $db;

    public function __construct($database)
    {
        $this->db = $database;
    }

    /**
     * GET /brokers/{brokerId}/pricing
     *
     * Retrieves all pricing for a specific broker
     *
     * @param int $brokerId The broker ID
     * @return array JSON response with pricing data
     */
    public function getPricing($brokerId)
    {
        // Validate broker ID
        if (!is_numeric($brokerId) || $brokerId <= 0) {
            return $this->errorResponse('Invalid broker ID', 400);
        }

        try {
            // Check if broker exists
            $brokerQuery = "SELECT id FROM brokers WHERE id = ?";
            $stmt = $this->db->prepare($brokerQuery);
            $stmt->execute([$brokerId]);

            if ($stmt->rowCount() === 0) {
                return $this->errorResponse('Broker not found', 404);
            }

            // Fetch all pricing for this broker
            $query = "
                SELECT vehicle_type, duration, price
                FROM broker_pricing
                WHERE broker_id = ?
                ORDER BY vehicle_type, duration
            ";

            $stmt = $this->db->prepare($query);
            $stmt->execute([$brokerId]);
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            // Structure pricing data
            $pricing = [];
            foreach ($rows as $row) {
                $vehicleType = $row['vehicle_type'];
                $duration = (string)$row['duration'];
                $price = (float)$row['price'];

                if (!isset($pricing[$vehicleType])) {
                    $pricing[$vehicleType] = [];
                }
                $pricing[$vehicleType][$duration] = $price;
            }

            return [
                'success' => true,
                'pricing' => $pricing
            ];
        } catch (Exception $e) {
            return $this->errorResponse('Database error: ' . $e->getMessage(), 500);
        }
    }

    /**
     * PUT /brokers/{brokerId}/pricing
     *
     * Updates pricing for a specific broker
     *
     * @param int $brokerId The broker ID
     * @param array $data JSON request body with pricing array
     * @param int $userRole The role of the authenticated user (must be 1 for admin)
     * @return array JSON response
     */
    public function updatePricing($brokerId, $data, $userRole)
    {
        // Authorization check - only admins can update pricing
        if ($userRole != 1) {
            return $this->errorResponse('Unauthorized: Only admins can update pricing', 403);
        }

        // Validate broker ID
        if (!is_numeric($brokerId) || $brokerId <= 0) {
            return $this->errorResponse('Invalid broker ID', 400);
        }

        // Validate request data
        if (empty($data['pricing']) || !is_array($data['pricing'])) {
            return $this->errorResponse('Invalid pricing data format', 400);
        }

        try {
            // Check if broker exists
            $brokerQuery = "SELECT id FROM brokers WHERE id = ?";
            $stmt = $this->db->prepare($brokerQuery);
            $stmt->execute([$brokerId]);

            if ($stmt->rowCount() === 0) {
                return $this->errorResponse('Broker not found', 404);
            }

            // Start transaction
            $this->db->beginTransaction();

            // Delete existing pricing for this broker
            $deleteQuery = "DELETE FROM broker_pricing WHERE broker_id = ?";
            $stmt = $this->db->prepare($deleteQuery);
            $stmt->execute([$brokerId]);

            // Insert new pricing
            $insertQuery = "
                INSERT INTO broker_pricing (broker_id, vehicle_type, duration, price)
                VALUES (?, ?, ?, ?)
            ";
            $stmt = $this->db->prepare($insertQuery);

            foreach ($data['pricing'] as $vehicleType => $durations) {
                // Validate vehicle type
                if (!is_string($vehicleType) || empty($vehicleType)) {
                    throw new Exception('Invalid vehicle type: ' . $vehicleType);
                }

                // Validate durations object
                if (!is_array($durations)) {
                    throw new Exception('Invalid durations for vehicle type: ' . $vehicleType);
                }

                foreach ($durations as $duration => $price) {
                    // Validate duration
                    $durationInt = (int)$duration;
                    if ($durationInt <= 0) {
                        throw new Exception('Invalid duration: ' . $duration);
                    }

                    // Validate price
                    $priceFloat = (float)$price;
                    if ($priceFloat < 0) {
                        throw new Exception('Price cannot be negative for ' . $vehicleType . ' ' . $duration . ' days');
                    }

                    // Insert pricing
                    $stmt->execute([
                        $brokerId,
                        $vehicleType,
                        $durationInt,
                        $priceFloat
                    ]);
                }
            }

            // Commit transaction
            $this->db->commit();

            // Fetch updated pricing to return
            $updatedPricing = $this->getPricing($brokerId);

            return [
                'success' => true,
                'message' => 'Pricing updated successfully',
                'pricing' => $updatedPricing['pricing'] ?? []
            ];
        } catch (Exception $e) {
            // Rollback transaction on error
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            return $this->errorResponse('Error updating pricing: ' . $e->getMessage(), 500);
        }
    }

    /**
     * Helper function to format error responses
     *
     * @param string $message Error message
     * @param int $code HTTP status code
     * @return array JSON response
     */
    private function errorResponse($message, $code)
    {
        http_response_code($code);
        return [
            'success' => false,
            'error' => $message,
            'code' => $code
        ];
    }
}

/**
 * Example Route Implementation (for your API router)
 *
 * Use the controller like this in your API routes:
 *
 * GET /api/brokers/{id}/pricing
 * $controller = new BrokerPricingController($db);
 * $response = $controller->getPricing($_GET['id']);
 * echo json_encode($response);
 *
 * PUT /api/brokers/{id}/pricing
 * $controller = new BrokerPricingController($db);
 * $requestBody = json_decode(file_get_contents('php://input'), true);
 * $userRole = getAuthenticatedUserRole(); // Your auth function
 * $response = $controller->updatePricing($_GET['id'], $requestBody, $userRole);
 * echo json_encode($response);
 */
?>
