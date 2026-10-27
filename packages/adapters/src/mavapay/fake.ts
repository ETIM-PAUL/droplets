import { fakeProvider, fixtureFrom } from "../fake-provider";

export const fixture = fixtureFrom("mavapay");
export const fakeMavapay = (script: string[]) => fakeProvider("mavapay", script);
