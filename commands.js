import 'dotenv/config';
import { getRPSChoices } from './game.js';
import { capitalize, InstallGlobalCommands } from './utils.js';

// Get the game choices from game.js
function createCommandChoices() {
  const choices = getRPSChoices();
  const commandChoices = [];

  for (let choice of choices) {
    commandChoices.push({
      name: capitalize(choice),
      value: choice.toLowerCase(),
    });
  }

  return commandChoices;
}

// Command containing options
const CHALLENGE_COMMAND = {
  name: 'challenge',
  description: 'Challenge to a match of rock paper scissors',
  options: [
    {
      type: 3,
      name: 'object',
      description: 'Pick your object',
      required: true,
      choices: createCommandChoices(),
    },
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 2],
};

// OSRS item price command
const ITEMPRICE_COMMAND = {
  name: 'itemprice',
  description: 'Get the current Grand Exchange price for an OSRS item',
  options: [
    {
      type: 3,
      name: 'item',
      description: 'The item name to check price for',
      required: true,
    },
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

// Kill simulator command
const KILL_COMMAND = {
  name: 'kill',
  description: 'Simulate loot from killing a boss or monster',
  options: [
    {
      type: 4, // INTEGER type
      name: 'count',
      description: 'Number of kills to simulate (1-10000)',
      required: true,
      min_value: 1,
      max_value: 10000,
    },
    {
      type: 3, // STRING type
      name: 'boss',
      description: 'Boss or monster name',
      required: true,
    },
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const ALL_COMMANDS = [CHALLENGE_COMMAND, ITEMPRICE_COMMAND, KILL_COMMAND];

InstallGlobalCommands(process.env.APP_ID, ALL_COMMANDS);
