import { afterEach, describe, expect, it } from "vitest";
import { isRussianLocale, t } from "../src/i18n";
import { setTestLanguage } from "./__mocks__/obsidian";

afterEach(() => setTestLanguage("en"));

describe("localization", () => {
	it("keeps English copy for non-Russian Obsidian locales", () => {
		setTestLanguage("en");
		expect(isRussianLocale()).toBe(false);
		expect(t("Current tasks")).toBe("Current tasks");
	});

	it("uses Russian copy for Russian Obsidian locales", () => {
		setTestLanguage("ru");
		expect(isRussianLocale()).toBe(true);
		expect(t("Current tasks")).toBe("Текущие задачи");
		expect(t("Active tasks: {count}", { count: 3 })).toBe("Активных задач: 3");
	});

	it("falls back to source copy when a translation is not defined", () => {
		setTestLanguage("ru-RU");
		expect(t("Provider response detail")).toBe("Provider response detail");
	});
});
