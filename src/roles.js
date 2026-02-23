const Role = Object.freeze({
  Mafia: "Mafia",
  Doctor: "Doctor",
  Detective: "Detective",
  Villager: "Villager",
  Jester: "Jester"
});

const Phase = Object.freeze({
  Night: "Night",
  Discussion: "Discussion",
  Voting: "Voting",
  Results: "Results"
});

module.exports = {
  Role,
  Phase
};
