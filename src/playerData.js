const { Role } = require("./roles");

class PlayerData {
  constructor(id, displayName, role = Role.Villager) {
    this.id = id;
    this.displayName = displayName;
    this.role = role;
    this.isAlive = true;
    this.suspicionScore = 0;
    this.lastDialogue = "";
  }

  resetForNewGame() {
    this.isAlive = true;
    this.suspicionScore = 0;
    this.lastDialogue = "";
  }

  resetForNewRound() {
    this.suspicionScore = 0;
    this.lastDialogue = "";
  }
}

module.exports = {
  PlayerData
};
