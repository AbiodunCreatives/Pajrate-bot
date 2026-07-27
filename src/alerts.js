/**
 * alerts.js
 * ----------
 * In-memory alert management for rate notifications.
 * Stores user alerts and checks them during polling cycles.
 */

const alerts = new Map(); // userId -> Set of alert objects

function addAlert(userId, targetRate, alertType = "offRamp") {
  if (!alerts.has(userId)) {
    alerts.set(userId, []);
  }

  const userAlerts = alerts.get(userId);
  const alertId = Date.now().toString();

  const newAlert = {
    id: alertId,
    targetRate: parseFloat(targetRate),
    type: alertType, // "offRamp" or "onRamp"
    createdAt: new Date(),
  };

  userAlerts.push(newAlert);
  return newAlert;
}

function removeAlert(userId, alertId) {
  if (!alerts.has(userId)) return false;

  const userAlerts = alerts.get(userId);
  const index = userAlerts.findIndex((a) => a.id === alertId);

  if (index === -1) return false;

  userAlerts.splice(index, 1);
  if (userAlerts.length === 0) {
    alerts.delete(userId);
  }
  return true;
}

function getUserAlerts(userId) {
  return alerts.get(userId) || [];
}

function getAllAlerts() {
  const allAlerts = {};
  alerts.forEach((userAlerts, userId) => {
    allAlerts[userId] = userAlerts;
  });
  return allAlerts;
}

function checkAlerts(currentOnRamp, currentOffRamp) {
  const triggeredAlerts = [];

  alerts.forEach((userAlerts, userId) => {
    userAlerts.forEach((alert) => {
      const currentRate =
        alert.type === "offRamp" ? currentOffRamp : currentOnRamp;

      // Check if alert threshold is hit (rate reached or exceeded the target)
      if (currentRate >= alert.targetRate) {
        triggeredAlerts.push({
          userId,
          alertId: alert.id,
          alertType: alert.type,
          targetRate: alert.targetRate,
          currentRate,
        });
      }
    });
  });

  return triggeredAlerts;
}

module.exports = {
  addAlert,
  removeAlert,
  getUserAlerts,
  getAllAlerts,
  checkAlerts,
};
