/**
 * Single source of truth for the leagues shown in the UI and queried from API-Football.
 * Imported by both the React app and the Pages Function, so it must stay dependency-free.
 *
 * @typedef {{ id: number, name: string, logo: string }} League
 */

const logo = (id) => `https://media.api-sports.io/football/leagues/${id}.png`;

/** @type {League[]} */
export const LEAGUES = [
  { id: 39, name: "Premier League", logo: logo(39) },
  { id: 135, name: "Serie A", logo: logo(135) },
  { id: 78, name: "Bundesliga", logo: logo(78) },
  { id: 140, name: "La Liga", logo: logo(140) },
  { id: 61, name: "Ligue 1", logo: logo(61) },
  { id: 71, name: "Brasileirão", logo: logo(71) },
  { id: 94, name: "Primeira Liga", logo: logo(94) },
  { id: 144, name: "Belgian Pro League", logo: logo(144) },
  { id: 88, name: "Eredivisie", logo: logo(88) },
  { id: 40, name: "EFL Championship", logo: logo(40) },
];

/** @type {number[]} */
export const LEAGUE_IDS = LEAGUES.map((league) => league.id);

/**
 * @param {number} id
 * @returns {string}
 */
export function leagueName(id) {
  return LEAGUES.find((league) => league.id === id)?.name ?? "";
}
