"""Shared setup for browser suites that exercise one building at a time."""
from playwright.sync_api import expect


def select_building_for_actions(panel):
    building = panel.locator('#location-picker').input_value()
    panel.evaluate("""async id => {
      const key='spotalert.ui.v1';
      const preferences=(await chrome.storage.local.get(key))[key] || {};
      await chrome.storage.local.set({[key]:{...preferences,checkBuildingIds:[id]}});
    }""", building)
    expect(panel.locator('#building-selection-count')).to_have_text('1 building selected')
