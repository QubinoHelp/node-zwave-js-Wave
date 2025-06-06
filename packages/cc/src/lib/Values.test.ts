import { CommandClasses } from "@zwave-js/core";
import { test } from "vitest";
import {
	AlarmSensorCCValues,
	BasicCCValues,
} from "../cc/_CCValues.generated.js";

// Since switching to codegen for CC values, these tests no longer work:
//
// test("defineDynamicCCValues, dynamic property and meta", (t) => {
// 	const dfn = V.defineDynamicCCValues(CommandClasses.Basic, {
// 		...V.dynamicPropertyAndKeyWithName(
// 			"prop1",
// 			(valueType: string) => valueType,
// 			(valueType: string) => valueType,
// 			({ property, propertyKey }: any) =>
// 				typeof property === "string" && property === propertyKey,
// 			(valueType: string) => ({
// 				...ValueMetadata.Any,
// 				readable: valueType === "readable",
// 			} as const),
// 			{ internal: true },
// 		),
// 		...V.dynamicPropertyAndKeyWithName(
// 			"prop2",
// 			(valueType: string) => valueType + "2",
// 			(valueType: string) => valueType + "2",
// 			({ property, propertyKey }: any) =>
// 				typeof property === "string"
// 				&& property.endsWith("2")
// 				&& property === propertyKey,
// 			(valueType: string) => ({
// 				...ValueMetadata.Any,
// 				writeable: valueType !== "not-writeable",
// 			}),
// 			{ secret: true },
// 		),
// 	});

// 	const actual1a = dfn.prop1("bar");
// 	t.expect(actual1a.id).toStrictEqual({
// 		commandClass: CommandClasses.Basic,
// 		property: "bar",
// 		propertyKey: "bar",
// 	});
// 	t.expect(actual1a.meta).toMatchObject({
// 		readable: false,
// 	});
// 	const actual1b = dfn.prop1("readable");
// 	t.expect(actual1b.id).toStrictEqual({
// 		commandClass: CommandClasses.Basic,
// 		property: "readable",
// 		propertyKey: "readable",
// 	});
// 	t.expect(actual1b.meta).toMatchObject({
// 		readable: true,
// 	});
// 	t.expect(dfn.prop1.options).toMatchObject({
// 		internal: true,
// 		secret: false,
// 	});

// 	const actual2a = dfn.prop2("bar");
// 	t.expect(actual2a.id).toStrictEqual({
// 		commandClass: CommandClasses.Basic,
// 		property: "bar2",
// 		propertyKey: "bar2",
// 	});
// 	t.expect(actual2a.meta).toMatchObject({
// 		writeable: true,
// 	});
// 	const actual2b = dfn.prop2("not-writeable");
// 	t.expect(actual2b.id).toStrictEqual({
// 		commandClass: CommandClasses.Basic,
// 		property: "not-writeable2",
// 		propertyKey: "not-writeable2",
// 	});
// 	t.expect(actual2b.meta).toMatchObject({
// 		writeable: false,
// 	});
// 	t.expect(dfn.prop2.options).toMatchObject({
// 		internal: false,
// 		secret: true,
// 	});

// 	t.expect(
// 		dfn.prop1.is({
// 			commandClass: CommandClasses.Basic,
// 			property: "the same",
// 			propertyKey: "the same",
// 		}),
// 	).toBe(true);

// 	t.expect(
// 		dfn.prop1.is({
// 			commandClass: CommandClasses.Basic,
// 			property: "the same",
// 			propertyKey: "not the same",
// 		}),
// 	).toBe(false);
// });

// // This is a copy of the Basic CC value definitions, for resiliency
// const BasicCCValues = Object.freeze({
// 	...V.defineStaticCCValues(CommandClasses.Basic, {
// 		...V.staticProperty("currentValue"),
// 		...V.staticProperty("targetValue"),
// 		// TODO: This should really not be a static CC value:
// 		...V.staticPropertyWithName("compatEvent", "event"),
// 	}),
// });

test("Basic CC, current value, no endpoint", (t) => {
	const actual = BasicCCValues.currentValue.id;
	t.expect(actual).toStrictEqual({
		commandClass: CommandClasses.Basic,
		property: "currentValue",
	});
});

test("Basic CC, current value, endpoint 2", (t) => {
	const actual = BasicCCValues.currentValue.endpoint(2);
	t.expect(actual).toStrictEqual({
		commandClass: CommandClasses.Basic,
		endpoint: 2,
		property: "currentValue",
	});
});

test("Basic CC, compat event, endpoint 2", (t) => {
	const actual = BasicCCValues.compatEvent.endpoint(2);
	t.expect(actual).toStrictEqual({
		commandClass: CommandClasses.Basic,
		endpoint: 2,
		property: "event",
	});
});

// const AlarmSensorCCValues = Object.freeze({
// 	...V.defineDynamicCCValues(CommandClasses["Alarm Sensor"], {
// 		...V.dynamicPropertyAndKeyWithName(
// 			"state",
// 			"state",
// 			(sensorType: number) => sensorType,
// 			({ property, propertyKey }) =>
// 				property === "state" && typeof propertyKey === "number",
// 			(sensorType: AlarmSensorType) => {
// 				const alarmName = getEnumMemberName(
// 					AlarmSensorType,
// 					sensorType,
// 				);
// 				return {
// 					...ValueMetadata.ReadOnlyBoolean,
// 					label: `${alarmName} state`,
// 					description: "Whether the alarm is active",
// 					ccSpecific: { sensorType },
// 				} as const;
// 			},
// 		),
// 		...V.dynamicPropertyWithName(
// 			"type",
// 			(sensorType: number) => sensorType,
// 			({ property, propertyKey }) =>
// 				typeof property === "number" && propertyKey == undefined,
// 		),
// 		// TODO: others
// 	}),
// });

test("(fake) Alarm Sensor CC, state (type 1), no endpoint", (t) => {
	const actual = AlarmSensorCCValues.state(1).id;
	t.expect(actual).toStrictEqual({
		commandClass: CommandClasses["Alarm Sensor"],
		property: "state",
		propertyKey: 1,
	});
});

test("(fake) Alarm Sensor CC, state (type 1), endpoint 5", (t) => {
	const actual = AlarmSensorCCValues.state(1).endpoint(5);
	t.expect(actual).toStrictEqual({
		commandClass: CommandClasses["Alarm Sensor"],
		endpoint: 5,
		property: "state",
		propertyKey: 1,
	});
});

test("(fake) Alarm Sensor CC, type (4), endpoint 5", (t) => {
	const actual = AlarmSensorCCValues.severity(4).endpoint(5);
	t.expect(actual).toStrictEqual({
		commandClass: CommandClasses["Alarm Sensor"],
		endpoint: 5,
		property: "severity",
		propertyKey: 4,
	});
});

test("(fake) Alarm Sensor CC, dynamic metadata", (t) => {
	const actual = AlarmSensorCCValues.state(1).meta;
	t.expect(actual).toStrictEqual({
		type: "boolean",
		readable: true,
		writeable: false,
		label: "Smoke state",
		description: "Whether the alarm is active",
		ccSpecific: { sensorType: 1 },
	});
});
