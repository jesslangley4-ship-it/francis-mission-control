#!/usr/bin/env node
'use strict';
/* Bakes francis-mission-control.template.html + cal-primary.json + cal-arsenal.json
   into index.html by rewriting the SNAPSHOT var block. Run from this directory. */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const TEMPLATE_PATH = path.join(ROOT, 'francis-mission-control.template.html');
const OUT_PATH = path.join(ROOT, 'index.html');

// Same keyword lists Langley Departures uses to tell the kids' events apart.
const FRANCIS_KEYWORDS = ['hockey', 'goalkeep', 'goalie', 'qehs', 'humber', 'trial'];
const MATHILDA_KEYWORDS = ['gymnastic', 'swim', 'nursery', 'happy days', 'allegro', 'emmerson'];
// Arsenal calendar carries men's fixtures, women's fixtures and ticket/ballot
// admin events all mixed together — this board only wants the next men's
// first-team match, so anything women's or ticket-admin is filtered out.
const NON_MATCH_PATTERN = /women|ballot|tickets? on sale/i;

function readJSON(name, fallback) {
  const p = path.join(ROOT, name);
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return fallback; }
}
function londonYMD(d) {
  return d.toLocaleDateString('en-CA', { timeZone: 'Europe/London' }); // YYYY-MM-DD
}
function londonHM(iso) {
  return new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
}
function matchesAny(title, keywords) {
  const t = (title || '').toLowerCase();
  return keywords.some(function (k) { return t.indexOf(k) !== -1; });
}
function toBoardEvent(ev) {
  const allDay = !!(ev.start && ev.start.date && !ev.start.dateTime);
  return {
    time: allDay ? null : londonHM(ev.start.dateTime),
    title: ev.summary || 'Event',
    loc: ev.location || '',
    allDay: allDay
  };
}

const now = new Date();
const todayYMD = londonYMD(now);

const primary = readJSON('cal-primary.json', { events: [] });
const arsenal = readJSON('cal-arsenal.json', { events: [] });

const primaryToday = (primary.events || []).filter(function (ev) {
  if (ev.start && ev.start.date && !ev.start.dateTime) {
    // All-day, possibly multi-day — end date is exclusive, so check today
    // falls inside [start, end).
    const startYMD = ev.start.date.slice(0, 10);
    const endYMD = ev.end && ev.end.date ? ev.end.date.slice(0, 10) : startYMD;
    return startYMD <= todayYMD && todayYMD < endYMD;
  }
  const startDate = ev.start && ev.start.dateTime;
  if (!startDate) return false;
  return londonYMD(new Date(startDate)) === todayYMD;
});

const todayEvents = primaryToday
  .filter(function (ev) { return matchesAny(ev.summary, FRANCIS_KEYWORDS); })
  .map(toBoardEvent);

// Mum @ 4pm: a non-all-day primary event today, not one of the kids', with a
// start time in the 15:00-17:00 window — closest to 16:00 wins. Best-effort;
// there's no explicit "this is Mum's thing" flag on the calendar to key off.
let mumAt4 = null;
let mumBestDiff = Infinity;
primaryToday.forEach(function (ev) {
  if (!ev.start || !ev.start.dateTime) return;
  if (matchesAny(ev.summary, FRANCIS_KEYWORDS) || matchesAny(ev.summary, MATHILDA_KEYWORDS)) return;
  const d = new Date(ev.start.dateTime);
  const hm = d.toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false });
  const parts = hm.split(':');
  const mins = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  if (mins < 15 * 60 || mins > 17 * 60) return;
  const diff = Math.abs(mins - 16 * 60);
  if (diff < mumBestDiff) {
    mumBestDiff = diff;
    mumAt4 = {
      title: ev.summary || 'Event',
      time: hm,
      endTime: ev.end && ev.end.dateTime ? londonHM(ev.end.dateTime) : null,
      loc: ev.location || ''
    };
  }
});

// Next men's first-team Arsenal fixture: soonest non-women's, non-admin event
// on or after now.
let nextMatch = null;
(arsenal.events || []).forEach(function (ev) {
  const startISO = ev.start && (ev.start.dateTime || ev.start.date);
  if (!startISO) return;
  if (NON_MATCH_PATTERN.test(ev.summary || '')) return;
  const d = new Date(startISO);
  if (d.getTime() < now.getTime()) return;
  if (nextMatch && new Date(nextMatch.startISO).getTime() <= d.getTime()) return;
  let comp = '';
  const compMatch = (ev.description || '').match(/Premier League|Champions League|Europa League|EFL Cup|English League Cup|FA Cup/i);
  if (compMatch) comp = compMatch[0];
  nextMatch = { summary: ev.summary || 'Arsenal fixture', comp: comp, startISO: startISO, loc: ev.location || '' };
});

const snapshot = {
  updatedISO: now.toISOString(),
  forDate: todayYMD,
  todayEvents: todayEvents,
  mumAt4: mumAt4,
  nextMatch: nextMatch
};

const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
const snapshotJs = 'var SNAPSHOT = ' + JSON.stringify(snapshot, null, 4) + ';';
const patched = template.replace(/var SNAPSHOT = \{[\s\S]*?\n {2}\};/, snapshotJs);

if (patched === template) {
  console.error('template drifted: SNAPSHOT block not found in ' + TEMPLATE_PATH);
  process.exit(1);
}

// Tea Planner mirror: meals.json (written by the daily routine from the
// planner) replaces the WEEK_MEAL_PLAN block.
const meals = readJSON('meals.json', null);
let out = patched;
let mealCount = 'skipped';
if (meals && typeof meals === 'object') {
  const mealsJs = 'var WEEK_MEAL_PLAN = ' +
    JSON.stringify(meals, null, 2).replace(/</g, '\\u003c').replace(/\n/g, '\n  ') + ';';
  const withMeals = patched.replace(/var WEEK_MEAL_PLAN = \{[\s\S]*?\n {2}\};/, function () { return mealsJs; });
  if (withMeals === patched) {
    console.error('template drifted: WEEK_MEAL_PLAN block not found in ' + TEMPLATE_PATH);
    process.exit(1);
  }
  out = withMeals;
  mealCount = Object.keys(meals).length;
}
console.log('meals=' + mealCount);

fs.writeFileSync(OUT_PATH, out);
console.log(
  'francis-mission-control: today ' + todayYMD +
  ' | todayEvents=' + todayEvents.length +
  ' | mumAt4=' + (mumAt4 ? 'yes' : 'no') +
  ' | nextMatch=' + (nextMatch ? nextMatch.summary : 'none')
);
