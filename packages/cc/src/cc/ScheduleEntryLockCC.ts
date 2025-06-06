import type { CCEncodingContext, CCParsingContext } from "@zwave-js/cc";
import {
	CommandClasses,
	type EndpointId,
	type GetValueDB,
	type MaybeNotKnown,
	type MessageOrCCLogEntry,
	MessagePriority,
	type MessageRecord,
	type SupervisionResult,
	type WithAddress,
	ZWaveError,
	ZWaveErrorCodes,
	encodeBitMask,
	getDSTInfo,
	isUnsupervisedOrSucceeded,
	parseBitMask,
	validatePayload,
} from "@zwave-js/core";
import {
	type AllOrNone,
	Bytes,
	formatDate,
	formatTime,
	getEnumMemberName,
	pick,
} from "@zwave-js/shared";
import { validateArgs } from "@zwave-js/transformers";
import { CCAPI } from "../lib/API.js";
import {
	type CCRaw,
	CommandClass,
	type InterviewContext,
	type PersistValuesContext,
} from "../lib/CommandClass.js";
import {
	API,
	CCCommand,
	ccValueProperty,
	ccValues,
	commandClass,
	expectedCCResponse,
	implementedVersion,
	useSupervision,
} from "../lib/CommandClassDecorators.js";
import { V } from "../lib/Values.js";
import {
	ScheduleEntryLockCommand,
	type ScheduleEntryLockDailyRepeatingSchedule,
	ScheduleEntryLockScheduleKind,
	ScheduleEntryLockSetAction,
	type ScheduleEntryLockSlotId,
	type ScheduleEntryLockWeekDaySchedule,
	ScheduleEntryLockWeekday,
	type ScheduleEntryLockYearDaySchedule,
	type Timezone,
} from "../lib/_Types.js";
import { encodeTimezone, parseTimezone } from "../lib/serializers.js";
import { UserCodeCC } from "./UserCodeCC.js";

export const ScheduleEntryLockCCValues = V.defineCCValues(
	CommandClasses["Schedule Entry Lock"],
	{
		...V.staticProperty("numWeekDaySlots", undefined, { internal: true }),
		...V.staticProperty("numYearDaySlots", undefined, { internal: true }),
		...V.staticProperty("numDailyRepeatingSlots", undefined, {
			internal: true,
		}),
		...V.dynamicPropertyAndKeyWithName(
			"userEnabled",
			"userEnabled",
			(userId: number) => userId,
			({ property, propertyKey }) =>
				property === "userEnabled" && typeof propertyKey === "number",
			undefined,
			{ internal: true },
		),
		...V.dynamicPropertyAndKeyWithName(
			"scheduleKind",
			"scheduleKind",
			(userId: number) => userId,
			({ property, propertyKey }) =>
				property === "scheduleKind" && typeof propertyKey === "number",
			undefined,
			{ internal: true },
		),
		...V.dynamicPropertyAndKeyWithName(
			"schedule",
			"schedule",
			(
				scheduleKind: ScheduleEntryLockScheduleKind,
				userId: number,
				slotId: number,
			) => (scheduleKind << 16) | (userId << 8) | slotId,
			({ property, propertyKey }) =>
				property === "schedule" && typeof propertyKey === "number",
			undefined,
			{ internal: true },
		),
	},
);

/** Caches information about a schedule */
function persistSchedule(
	this: ScheduleEntryLockCC,
	ctx: GetValueDB,
	scheduleKind: ScheduleEntryLockScheduleKind,
	userId: number,
	slotId: number,
	schedule:
		| ScheduleEntryLockWeekDaySchedule
		| ScheduleEntryLockYearDaySchedule
		| ScheduleEntryLockDailyRepeatingSchedule
		| false
		| undefined,
): void {
	const scheduleValue = ScheduleEntryLockCCValues.schedule(
		scheduleKind,
		userId,
		slotId,
	);

	if (schedule != undefined) {
		this.setValue(ctx, scheduleValue, schedule);
	} else {
		this.removeValue(ctx, scheduleValue);
	}
}

/** Updates the schedule kind assumed to be active for user in the cache */
function setUserCodeScheduleKindCached(
	ctx: GetValueDB,
	endpoint: EndpointId,
	userId: number,
	scheduleKind: ScheduleEntryLockScheduleKind,
): void {
	ctx
		.getValueDB(endpoint.nodeId)
		.setValue(
			ScheduleEntryLockCCValues.scheduleKind(userId).endpoint(
				endpoint.index,
			),
			scheduleKind,
		);
}

/** Updates whether scheduling is active for one or all user(s) in the cache */
function setUserCodeScheduleEnabledCached(
	ctx: GetValueDB,
	endpoint: EndpointId,
	userId: number | undefined,
	enabled: boolean,
): void {
	const setEnabled = (userId: number) => {
		ctx
			.getValueDB(endpoint.nodeId)
			.setValue(
				ScheduleEntryLockCCValues.userEnabled(userId).endpoint(
					endpoint.index,
				),
				enabled,
			);
	};

	if (userId == undefined) {
		// Enable/disable all users
		const numUsers = UserCodeCC.getSupportedUsersCached(ctx, endpoint)
			?? 0;

		for (let userId = 1; userId <= numUsers; userId++) {
			setEnabled(userId);
		}
	} else {
		setEnabled(userId);
	}
}

@API(CommandClasses["Schedule Entry Lock"])
export class ScheduleEntryLockCCAPI extends CCAPI {
	public supportsCommand(
		cmd: ScheduleEntryLockCommand,
	): MaybeNotKnown<boolean> {
		switch (cmd) {
			case ScheduleEntryLockCommand.EnableSet:
			case ScheduleEntryLockCommand.EnableAllSet:
			case ScheduleEntryLockCommand.WeekDayScheduleSet:
			case ScheduleEntryLockCommand.WeekDayScheduleGet:
			case ScheduleEntryLockCommand.YearDayScheduleSet:
			case ScheduleEntryLockCommand.YearDayScheduleGet:
			case ScheduleEntryLockCommand.SupportedGet:
				return true; // V1

			case ScheduleEntryLockCommand.TimeOffsetSet:
			case ScheduleEntryLockCommand.TimeOffsetGet:
				return this.version >= 2;

			case ScheduleEntryLockCommand.DailyRepeatingScheduleSet:
			case ScheduleEntryLockCommand.DailyRepeatingScheduleGet:
				return this.version >= 3;
		}
		return super.supportsCommand(cmd);
	}

	/**
	 * Enables or disables schedules. If a user ID is given, that user's
	 * schedules will be enabled or disabled. If no user ID is given, all schedules
	 * will be affected.
	 */
	@validateArgs()
	public async setEnabled(
		enabled: boolean,
		userId?: number,
	): Promise<SupervisionResult | undefined> {
		let result: SupervisionResult | undefined;
		if (userId != undefined) {
			this.assertSupportsCommand(
				ScheduleEntryLockCommand,
				ScheduleEntryLockCommand.EnableSet,
			);

			const cc = new ScheduleEntryLockCCEnableSet({
				nodeId: this.endpoint.nodeId,
				endpointIndex: this.endpoint.index,
				userId,
				enabled,
			});

			result = await this.host.sendCommand(cc, this.commandOptions);
		} else {
			this.assertSupportsCommand(
				ScheduleEntryLockCommand,
				ScheduleEntryLockCommand.EnableAllSet,
			);

			const cc = new ScheduleEntryLockCCEnableAllSet({
				nodeId: this.endpoint.nodeId,
				endpointIndex: this.endpoint.index,
				enabled,
			});

			result = await this.host.sendCommand(cc, this.commandOptions);
		}

		if (this.isSinglecast() && isUnsupervisedOrSucceeded(result)) {
			// Remember the new state in the cache
			setUserCodeScheduleEnabledCached(
				this.host,
				this.endpoint,
				userId,
				enabled,
			);
		}

		return result;
	}

	// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
	public async getNumSlots() {
		this.assertSupportsCommand(
			ScheduleEntryLockCommand,
			ScheduleEntryLockCommand.SupportedGet,
		);

		const cc = new ScheduleEntryLockCCSupportedGet({
			nodeId: this.endpoint.nodeId,
			endpointIndex: this.endpoint.index,
		});

		const result = await this.host.sendCommand<
			ScheduleEntryLockCCSupportedReport
		>(
			cc,
			this.commandOptions,
		);

		if (result) {
			return pick(result, [
				"numWeekDaySlots",
				"numYearDaySlots",
				"numDailyRepeatingSlots",
			]);
		}
	}

	@validateArgs()
	public async setWeekDaySchedule(
		slot: ScheduleEntryLockSlotId,
		schedule?: ScheduleEntryLockWeekDaySchedule,
	): Promise<SupervisionResult | undefined> {
		this.assertSupportsCommand(
			ScheduleEntryLockCommand,
			ScheduleEntryLockCommand.WeekDayScheduleSet,
		);

		if (this.isSinglecast()) {
			const numSlots = ScheduleEntryLockCC.getNumWeekDaySlotsCached(
				this.host,
				this.endpoint,
			);

			if (slot.slotId < 1 || slot.slotId > numSlots) {
				throw new ZWaveError(
					`The schedule slot # must be between 1 and the number of supported day-of-week slots ${numSlots}.`,
					ZWaveErrorCodes.Argument_Invalid,
				);
			}
		}

		if (schedule) {
			if (
				schedule.stopHour < schedule.startHour
				|| schedule.stopHour === schedule.startHour
					&& schedule.stopMinute <= schedule.startMinute
			) {
				throw new ZWaveError(
					`The stop time must be after the start time.`,
					ZWaveErrorCodes.Argument_Invalid,
				);
			}
		}

		const cc = new ScheduleEntryLockCCWeekDayScheduleSet({
			nodeId: this.endpoint.nodeId,
			endpointIndex: this.endpoint.index,
			...slot,
			...(schedule
				? {
					action: ScheduleEntryLockSetAction.Set,
					...schedule,
				}
				: {
					action: ScheduleEntryLockSetAction.Erase,
				}),
		});

		const result = await this.host.sendCommand(cc, this.commandOptions);

		if (this.isSinglecast() && isUnsupervisedOrSucceeded(result)) {
			// Editing (but not erasing) a schedule will enable scheduling for that user
			// and switch it to the current scheduling kind
			if (!!schedule) {
				setUserCodeScheduleEnabledCached(
					this.host,
					this.endpoint,
					slot.userId,
					true,
				);
				setUserCodeScheduleKindCached(
					this.host,
					this.endpoint,
					slot.userId,
					ScheduleEntryLockScheduleKind.WeekDay,
				);
			}

			// And cache the schedule
			persistSchedule.call(
				cc,
				this.host,
				ScheduleEntryLockScheduleKind.WeekDay,
				slot.userId,
				slot.slotId,
				schedule ?? false,
			);
		}

		return result;
	}

	@validateArgs()
	public async getWeekDaySchedule(
		slot: ScheduleEntryLockSlotId,
	): Promise<MaybeNotKnown<ScheduleEntryLockWeekDaySchedule>> {
		this.assertSupportsCommand(
			ScheduleEntryLockCommand,
			ScheduleEntryLockCommand.WeekDayScheduleSet,
		);

		const cc = new ScheduleEntryLockCCWeekDayScheduleGet({
			nodeId: this.endpoint.nodeId,
			endpointIndex: this.endpoint.index,
			...slot,
		});
		const result = await this.host.sendCommand<
			ScheduleEntryLockCCWeekDayScheduleReport
		>(
			cc,
			this.commandOptions,
		);

		if (result?.weekday != undefined) {
			return {
				weekday: result.weekday,
				startHour: result.startHour!,
				startMinute: result.startMinute!,
				stopHour: result.stopHour!,
				stopMinute: result.stopMinute!,
			};
		}
	}

	@validateArgs()
	public async setYearDaySchedule(
		slot: ScheduleEntryLockSlotId,
		schedule?: ScheduleEntryLockYearDaySchedule,
	): Promise<SupervisionResult | undefined> {
		this.assertSupportsCommand(
			ScheduleEntryLockCommand,
			ScheduleEntryLockCommand.YearDayScheduleSet,
		);

		if (this.isSinglecast()) {
			const numSlots = ScheduleEntryLockCC.getNumYearDaySlotsCached(
				this.host,
				this.endpoint,
			);

			if (slot.slotId < 1 || slot.slotId > numSlots) {
				throw new ZWaveError(
					`The schedule slot # must be between 1 and the number of supported day-of-year slots ${numSlots}.`,
					ZWaveErrorCodes.Argument_Invalid,
				);
			}
		}

		if (schedule) {
			const startDate = new Date(
				schedule.startYear,
				schedule.startMonth - 1,
				schedule.startDay,
				schedule.startHour,
				schedule.startMinute,
			);
			const stopDate = new Date(
				schedule.stopYear,
				schedule.stopMonth - 1,
				schedule.stopDay,
				schedule.stopHour,
				schedule.stopMinute,
			);
			if (stopDate <= startDate) {
				throw new ZWaveError(
					`The stop date must be after the start date.`,
					ZWaveErrorCodes.Argument_Invalid,
				);
			}
		}

		const cc = new ScheduleEntryLockCCYearDayScheduleSet({
			nodeId: this.endpoint.nodeId,
			endpointIndex: this.endpoint.index,
			...slot,
			...(schedule
				? {
					action: ScheduleEntryLockSetAction.Set,
					...schedule,
				}
				: {
					action: ScheduleEntryLockSetAction.Erase,
				}),
		});

		const result = await this.host.sendCommand(cc, this.commandOptions);

		if (this.isSinglecast() && isUnsupervisedOrSucceeded(result)) {
			// Editing (but not erasing) a schedule will enable scheduling for that user
			// and switch it to the current scheduling kind
			if (!!schedule) {
				setUserCodeScheduleEnabledCached(
					this.host,
					this.endpoint,
					slot.userId,
					true,
				);
				setUserCodeScheduleKindCached(
					this.host,
					this.endpoint,
					slot.userId,
					ScheduleEntryLockScheduleKind.YearDay,
				);
			}

			// And cache the schedule
			persistSchedule.call(
				cc,
				this.host,
				ScheduleEntryLockScheduleKind.YearDay,
				slot.userId,
				slot.slotId,
				schedule ?? false,
			);
		}

		return result;
	}

	@validateArgs()
	public async getYearDaySchedule(
		slot: ScheduleEntryLockSlotId,
	): Promise<MaybeNotKnown<ScheduleEntryLockYearDaySchedule>> {
		this.assertSupportsCommand(
			ScheduleEntryLockCommand,
			ScheduleEntryLockCommand.YearDayScheduleSet,
		);

		const cc = new ScheduleEntryLockCCYearDayScheduleGet({
			nodeId: this.endpoint.nodeId,
			endpointIndex: this.endpoint.index,
			...slot,
		});
		const result = await this.host.sendCommand<
			ScheduleEntryLockCCYearDayScheduleReport
		>(
			cc,
			this.commandOptions,
		);

		if (result?.startYear != undefined) {
			return {
				startYear: result.startYear,
				startMonth: result.startMonth!,
				startDay: result.startDay!,
				startHour: result.startHour!,
				startMinute: result.startMinute!,
				stopYear: result.stopYear!,
				stopMonth: result.stopMonth!,
				stopDay: result.stopDay!,
				stopHour: result.stopHour!,
				stopMinute: result.stopMinute!,
			};
		}
	}

	@validateArgs()
	public async setDailyRepeatingSchedule(
		slot: ScheduleEntryLockSlotId,
		schedule?: ScheduleEntryLockDailyRepeatingSchedule,
	): Promise<SupervisionResult | undefined> {
		this.assertSupportsCommand(
			ScheduleEntryLockCommand,
			ScheduleEntryLockCommand.DailyRepeatingScheduleSet,
		);

		if (this.isSinglecast()) {
			const numSlots = ScheduleEntryLockCC
				.getNumDailyRepeatingSlotsCached(
					this.host,
					this.endpoint,
				);

			if (slot.slotId < 1 || slot.slotId > numSlots) {
				throw new ZWaveError(
					`The schedule slot # must be between 1 and the number of supported daily repeating slots ${numSlots}.`,
					ZWaveErrorCodes.Argument_Invalid,
				);
			}
		}

		const cc = new ScheduleEntryLockCCDailyRepeatingScheduleSet({
			nodeId: this.endpoint.nodeId,
			endpointIndex: this.endpoint.index,
			...slot,
			...(schedule
				? {
					action: ScheduleEntryLockSetAction.Set,
					...schedule,
				}
				: {
					action: ScheduleEntryLockSetAction.Erase,
				}),
		});

		const result = await this.host.sendCommand(cc, this.commandOptions);

		if (this.isSinglecast() && isUnsupervisedOrSucceeded(result)) {
			// Editing (but not erasing) a schedule will enable scheduling for that user
			// and switch it to the current scheduling kind
			if (!!schedule) {
				setUserCodeScheduleEnabledCached(
					this.host,
					this.endpoint,
					slot.userId,
					true,
				);
				setUserCodeScheduleKindCached(
					this.host,
					this.endpoint,
					slot.userId,
					ScheduleEntryLockScheduleKind.DailyRepeating,
				);
			}

			// And cache the schedule
			persistSchedule.call(
				cc,
				this.host,
				ScheduleEntryLockScheduleKind.DailyRepeating,
				slot.userId,
				slot.slotId,
				schedule ?? false,
			);
		}

		return result;
	}

	@validateArgs()
	public async getDailyRepeatingSchedule(
		slot: ScheduleEntryLockSlotId,
	): Promise<MaybeNotKnown<ScheduleEntryLockDailyRepeatingSchedule>> {
		this.assertSupportsCommand(
			ScheduleEntryLockCommand,
			ScheduleEntryLockCommand.DailyRepeatingScheduleSet,
		);

		const cc = new ScheduleEntryLockCCDailyRepeatingScheduleGet({
			nodeId: this.endpoint.nodeId,
			endpointIndex: this.endpoint.index,
			...slot,
		});
		const result = await this.host.sendCommand<
			ScheduleEntryLockCCDailyRepeatingScheduleReport
		>(
			cc,
			this.commandOptions,
		);

		if (result?.weekdays != undefined) {
			return {
				weekdays: result.weekdays,
				startHour: result.startHour!,
				startMinute: result.startMinute!,
				durationHour: result.durationHour!,
				durationMinute: result.durationMinute!,
			};
		}
	}

	public async getTimezone(): Promise<MaybeNotKnown<Timezone>> {
		this.assertSupportsCommand(
			ScheduleEntryLockCommand,
			ScheduleEntryLockCommand.TimeOffsetGet,
		);

		const cc = new ScheduleEntryLockCCTimeOffsetGet({
			nodeId: this.endpoint.nodeId,
			endpointIndex: this.endpoint.index,
		});
		const result = await this.host.sendCommand<
			ScheduleEntryLockCCTimeOffsetReport
		>(
			cc,
			this.commandOptions,
		);

		if (result) {
			return pick(result, ["standardOffset", "dstOffset"]);
		}
	}

	@validateArgs()
	public async setTimezone(
		timezone: Timezone,
	): Promise<SupervisionResult | undefined> {
		this.assertSupportsCommand(
			ScheduleEntryLockCommand,
			ScheduleEntryLockCommand.TimeOffsetSet,
		);

		const cc = new ScheduleEntryLockCCTimeOffsetSet({
			nodeId: this.endpoint.nodeId,
			endpointIndex: this.endpoint.index,
			...timezone,
		});

		return this.host.sendCommand(cc, this.commandOptions);
	}
}

@commandClass(CommandClasses["Schedule Entry Lock"])
@implementedVersion(3)
@ccValues(ScheduleEntryLockCCValues)
export class ScheduleEntryLockCC extends CommandClass {
	declare ccCommand: ScheduleEntryLockCommand;

	public async interview(
		ctx: InterviewContext,
	): Promise<void> {
		const node = this.getNode(ctx)!;
		const endpoint = this.getEndpoint(ctx)!;
		const api = CCAPI.create(
			CommandClasses["Schedule Entry Lock"],
			ctx,
			endpoint,
		).withOptions({
			priority: MessagePriority.NodeQuery,
		});

		ctx.logNode(node.id, {
			endpoint: this.endpointIndex,
			message: `Interviewing ${this.ccName}...`,
			direction: "none",
		});

		ctx.logNode(node.id, {
			endpoint: this.endpointIndex,
			message: "Querying supported number of schedule slots...",
			direction: "outbound",
		});
		const slotsResp = await api.getNumSlots();
		if (slotsResp) {
			let logMessage = `received supported number of schedule slots:
day of week:     ${slotsResp.numWeekDaySlots}
day of year:     ${slotsResp.numYearDaySlots}`;
			if (slotsResp.numDailyRepeatingSlots != undefined) {
				logMessage += `
daily repeating: ${slotsResp.numDailyRepeatingSlots}`;
			}
			ctx.logNode(node.id, {
				endpoint: this.endpointIndex,
				message: logMessage,
				direction: "inbound",
			});
		}

		// If the timezone is not configured with the Time CC, do it here
		if (
			api.supportsCommand(ScheduleEntryLockCommand.TimeOffsetSet)
			&& (!endpoint.supportsCC(CommandClasses.Time)
				|| endpoint.getCCVersion(CommandClasses.Time) < 2)
		) {
			ctx.logNode(node.id, {
				endpoint: this.endpointIndex,
				message: "setting timezone information...",
				direction: "outbound",
			});
			// Set the correct timezone on this node
			const timezone = getDSTInfo();
			await api.setTimezone(timezone);
		}

		// Remember that the interview is complete
		this.setInterviewComplete(ctx, true);
	}

	/**
	 * Returns the number of supported day-of-week slots.
	 * This only works AFTER the interview process
	 */
	public static getNumWeekDaySlotsCached(
		ctx: GetValueDB,
		endpoint: EndpointId,
	): number {
		return ctx
			.getValueDB(endpoint.nodeId)
			.getValue(
				ScheduleEntryLockCCValues.numWeekDaySlots.endpoint(
					endpoint.index,
				),
			) || 0;
	}

	/**
	 * Returns the number of supported day-of-year slots.
	 * This only works AFTER the interview process
	 */
	public static getNumYearDaySlotsCached(
		ctx: GetValueDB,
		endpoint: EndpointId,
	): number {
		return ctx
			.getValueDB(endpoint.nodeId)
			.getValue(
				ScheduleEntryLockCCValues.numYearDaySlots.endpoint(
					endpoint.index,
				),
			) || 0;
	}

	/**
	 * Returns the number of supported daily-repeating slots.
	 * This only works AFTER the interview process
	 */
	public static getNumDailyRepeatingSlotsCached(
		ctx: GetValueDB,
		endpoint: EndpointId,
	): number {
		return ctx
			.getValueDB(endpoint.nodeId)
			.getValue(
				ScheduleEntryLockCCValues.numDailyRepeatingSlots.endpoint(
					endpoint.index,
				),
			) || 0;
	}

	/**
	 * Returns whether scheduling for a given user ID (most likely) enabled. Since the Schedule Entry Lock CC
	 * provides no way to query the enabled state, Z-Wave JS tracks this in its own cache.
	 *
	 * This only works AFTER the interview process and is likely to be wrong if a device
	 * with existing schedules is queried. To be sure, disable scheduling for all users and enable
	 * only the desired ones.
	 */
	public static getUserCodeScheduleEnabledCached(
		ctx: GetValueDB,
		endpoint: EndpointId,
		userId: number,
	): boolean {
		return !!ctx
			.getValueDB(endpoint.nodeId)
			.getValue(
				ScheduleEntryLockCCValues.userEnabled(userId).endpoint(
					endpoint.index,
				),
			);
	}

	/**
	 * Returns which scheduling kind is (most likely) enabled for a given user ID . Since the Schedule Entry Lock CC
	 * provides no way to query the current state, Z-Wave JS tracks this in its own cache.
	 *
	 * This only works AFTER the interview process and is likely to be wrong if a device
	 * with existing schedules is queried. To be sure, edit a schedule of the desired kind
	 * which will automatically switch the user to that scheduling kind.
	 */
	public static getUserCodeScheduleKindCached(
		ctx: GetValueDB,
		endpoint: EndpointId,
		userId: number,
	): MaybeNotKnown<ScheduleEntryLockScheduleKind> {
		return ctx
			.getValueDB(endpoint.nodeId)
			.getValue<ScheduleEntryLockScheduleKind>(
				ScheduleEntryLockCCValues.scheduleKind(userId).endpoint(
					endpoint.index,
				),
			);
	}

	public static getScheduleCached(
		ctx: GetValueDB,
		endpoint: EndpointId,
		scheduleKind: ScheduleEntryLockScheduleKind.WeekDay,
		userId: number,
		slotId: number,
	): MaybeNotKnown<ScheduleEntryLockWeekDaySchedule | false>;

	public static getScheduleCached(
		ctx: GetValueDB,
		endpoint: EndpointId,
		scheduleKind: ScheduleEntryLockScheduleKind.YearDay,
		userId: number,
		slotId: number,
	): MaybeNotKnown<ScheduleEntryLockYearDaySchedule | false>;

	public static getScheduleCached(
		ctx: GetValueDB,
		endpoint: EndpointId,
		scheduleKind: ScheduleEntryLockScheduleKind.DailyRepeating,
		userId: number,
		slotId: number,
	): MaybeNotKnown<ScheduleEntryLockDailyRepeatingSchedule | false>;

	// Catch-all overload for applications which haven't narrowed `scheduleKind`
	public static getScheduleCached(
		ctx: GetValueDB,
		endpoint: EndpointId,
		scheduleKind: ScheduleEntryLockScheduleKind,
		userId: number,
		slotId: number,
	): MaybeNotKnown<
		| ScheduleEntryLockWeekDaySchedule
		| ScheduleEntryLockYearDaySchedule
		| ScheduleEntryLockDailyRepeatingSchedule
		| false
	>;

	/**
	 * Returns the assumed state of a schedule. Since the Schedule Entry Lock CC
	 * provides no way to query the current state, Z-Wave JS tracks this in its own cache.
	 *
	 * A return value of `false` means the slot is empty, a return value of `undefined` means the information is not cached yet.
	 *
	 * This only works AFTER the interview process.
	 */
	public static getScheduleCached(
		ctx: GetValueDB,
		endpoint: EndpointId,
		scheduleKind: ScheduleEntryLockScheduleKind,
		userId: number,
		slotId: number,
	): MaybeNotKnown<
		| ScheduleEntryLockWeekDaySchedule
		| ScheduleEntryLockYearDaySchedule
		| ScheduleEntryLockDailyRepeatingSchedule
		| false
	> {
		return ctx
			.getValueDB(endpoint.nodeId)
			.getValue(
				ScheduleEntryLockCCValues.schedule(
					scheduleKind,
					userId,
					slotId,
				).endpoint(endpoint.index),
			);
	}
}

// @publicAPI
export interface ScheduleEntryLockCCEnableSetOptions {
	userId: number;
	enabled: boolean;
}

@CCCommand(ScheduleEntryLockCommand.EnableSet)
@useSupervision()
export class ScheduleEntryLockCCEnableSet extends ScheduleEntryLockCC {
	public constructor(
		options: WithAddress<ScheduleEntryLockCCEnableSetOptions>,
	) {
		super(options);
		this.userId = options.userId;
		this.enabled = options.enabled;
	}

	public static from(
		raw: CCRaw,
		ctx: CCParsingContext,
	): ScheduleEntryLockCCEnableSet {
		validatePayload(raw.payload.length >= 2);
		const userId = raw.payload[0];
		const enabled: boolean = raw.payload[1] === 0x01;

		return new this({
			nodeId: ctx.sourceNodeId,
			userId,
			enabled,
		});
	}

	public userId: number;
	public enabled: boolean;

	public serialize(ctx: CCEncodingContext): Promise<Bytes> {
		this.payload = Bytes.from([this.userId, this.enabled ? 0x01 : 0x00]);
		return super.serialize(ctx);
	}

	public toLogEntry(ctx?: GetValueDB): MessageOrCCLogEntry {
		return {
			...super.toLogEntry(ctx),
			message: {
				"user ID": this.userId,
				action: this.enabled ? "enable" : "disable",
			},
		};
	}
}

// @publicAPI
export interface ScheduleEntryLockCCEnableAllSetOptions {
	enabled: boolean;
}

@CCCommand(ScheduleEntryLockCommand.EnableAllSet)
@useSupervision()
export class ScheduleEntryLockCCEnableAllSet extends ScheduleEntryLockCC {
	public constructor(
		options: WithAddress<ScheduleEntryLockCCEnableAllSetOptions>,
	) {
		super(options);
		this.enabled = options.enabled;
	}

	public static from(
		raw: CCRaw,
		ctx: CCParsingContext,
	): ScheduleEntryLockCCEnableAllSet {
		validatePayload(raw.payload.length >= 1);
		const enabled: boolean = raw.payload[0] === 0x01;

		return new this({
			nodeId: ctx.sourceNodeId,
			enabled,
		});
	}

	public enabled: boolean;

	public serialize(ctx: CCEncodingContext): Promise<Bytes> {
		this.payload = Bytes.from([this.enabled ? 0x01 : 0x00]);
		return super.serialize(ctx);
	}

	public toLogEntry(ctx?: GetValueDB): MessageOrCCLogEntry {
		return {
			...super.toLogEntry(ctx),
			message: {
				action: this.enabled ? "enable all" : "disable all",
			},
		};
	}
}

// @publicAPI
export interface ScheduleEntryLockCCSupportedReportOptions {
	numWeekDaySlots: number;
	numYearDaySlots: number;
	numDailyRepeatingSlots?: number;
}

@CCCommand(ScheduleEntryLockCommand.SupportedReport)
@ccValueProperty("numWeekDaySlots", ScheduleEntryLockCCValues.numWeekDaySlots)
@ccValueProperty("numYearDaySlots", ScheduleEntryLockCCValues.numYearDaySlots)
@ccValueProperty(
	"numDailyRepeatingSlots",
	ScheduleEntryLockCCValues.numDailyRepeatingSlots,
)
export class ScheduleEntryLockCCSupportedReport extends ScheduleEntryLockCC {
	public constructor(
		options: WithAddress<ScheduleEntryLockCCSupportedReportOptions>,
	) {
		super(options);
		this.numWeekDaySlots = options.numWeekDaySlots;
		this.numYearDaySlots = options.numYearDaySlots;
		this.numDailyRepeatingSlots = options.numDailyRepeatingSlots;
	}

	public static from(
		raw: CCRaw,
		ctx: CCParsingContext,
	): ScheduleEntryLockCCSupportedReport {
		validatePayload(raw.payload.length >= 2);
		const numWeekDaySlots = raw.payload[0];
		const numYearDaySlots = raw.payload[1];
		let numDailyRepeatingSlots: number | undefined;
		if (raw.payload.length >= 3) {
			numDailyRepeatingSlots = raw.payload[2];
		}

		return new this({
			nodeId: ctx.sourceNodeId,
			numWeekDaySlots,
			numYearDaySlots,
			numDailyRepeatingSlots,
		});
	}

	public numWeekDaySlots: number;

	public numYearDaySlots: number;

	public numDailyRepeatingSlots: number | undefined;

	public serialize(ctx: CCEncodingContext): Promise<Bytes> {
		this.payload = Bytes.from([
			this.numWeekDaySlots,
			this.numYearDaySlots,
			this.numDailyRepeatingSlots ?? 0,
		]);
		return super.serialize(ctx);
	}

	public toLogEntry(ctx?: GetValueDB): MessageOrCCLogEntry {
		const message: MessageRecord = {
			"no. of weekday schedule slots": this.numWeekDaySlots,
			"no. of day-of-year schedule slots": this.numYearDaySlots,
		};
		if (this.numDailyRepeatingSlots != undefined) {
			message["no. of daily repeating schedule slots"] =
				this.numDailyRepeatingSlots;
		}
		return {
			...super.toLogEntry(ctx),
			message,
		};
	}
}

@CCCommand(ScheduleEntryLockCommand.SupportedGet)
@expectedCCResponse(ScheduleEntryLockCCSupportedReport)
export class ScheduleEntryLockCCSupportedGet extends ScheduleEntryLockCC {}

/** @publicAPI */
export type ScheduleEntryLockCCWeekDayScheduleSetOptions =
	& ScheduleEntryLockSlotId
	& (
		| {
			action: ScheduleEntryLockSetAction.Erase;
		}
		| ({
			action: ScheduleEntryLockSetAction.Set;
		} & ScheduleEntryLockWeekDaySchedule)
	);

@CCCommand(ScheduleEntryLockCommand.WeekDayScheduleSet)
@useSupervision()
export class ScheduleEntryLockCCWeekDayScheduleSet extends ScheduleEntryLockCC {
	public constructor(
		options: WithAddress<ScheduleEntryLockCCWeekDayScheduleSetOptions>,
	) {
		super(options);
		this.userId = options.userId;
		this.slotId = options.slotId;
		this.action = options.action;
		if (options.action === ScheduleEntryLockSetAction.Set) {
			this.weekday = options.weekday;
			this.startHour = options.startHour;
			this.startMinute = options.startMinute;
			this.stopHour = options.stopHour;
			this.stopMinute = options.stopMinute;
		}
	}

	public static from(
		raw: CCRaw,
		ctx: CCParsingContext,
	): ScheduleEntryLockCCWeekDayScheduleSet {
		validatePayload(raw.payload.length >= 3);
		const action: ScheduleEntryLockSetAction = raw.payload[0];

		validatePayload(
			action === ScheduleEntryLockSetAction.Set
				|| action === ScheduleEntryLockSetAction.Erase,
		);
		const userId = raw.payload[1];
		const slotId = raw.payload[2];

		if (action !== ScheduleEntryLockSetAction.Set) {
			return new this({
				nodeId: ctx.sourceNodeId,
				action,
				userId,
				slotId,
			});
		}

		validatePayload(raw.payload.length >= 8);
		const weekday: ScheduleEntryLockWeekday = raw.payload[3];
		const startHour = raw.payload[4];
		const startMinute = raw.payload[5];
		const stopHour = raw.payload[6];
		const stopMinute = raw.payload[7];

		return new this({
			nodeId: ctx.sourceNodeId,
			action,
			userId,
			slotId,
			weekday,
			startHour,
			startMinute,
			stopHour,
			stopMinute,
		});
	}

	public userId: number;
	public slotId: number;

	public action: ScheduleEntryLockSetAction;

	public weekday?: ScheduleEntryLockWeekday;
	public startHour?: number;
	public startMinute?: number;
	public stopHour?: number;
	public stopMinute?: number;

	public serialize(ctx: CCEncodingContext): Promise<Bytes> {
		this.payload = Bytes.from([
			this.action,
			this.userId,
			this.slotId,
			// The report should have these fields set to 0xff
			// if the slot is erased. The specs don't mention anything
			// for the Set command, so we just assume the same is okay
			this.weekday ?? 0xff,
			this.startHour ?? 0xff,
			this.startMinute ?? 0xff,
			this.stopHour ?? 0xff,
			this.stopMinute ?? 0xff,
		]);
		return super.serialize(ctx);
	}

	public toLogEntry(ctx?: GetValueDB): MessageOrCCLogEntry {
		let message: MessageRecord;
		if (this.action === ScheduleEntryLockSetAction.Erase) {
			message = {
				"user ID": this.userId,
				"slot #": this.slotId,
				action: "erase",
			};
		} else {
			message = {
				"user ID": this.userId,
				"slot #": this.slotId,
				action: "set",
				weekday: getEnumMemberName(
					ScheduleEntryLockWeekday,
					this.weekday!,
				),
				"start time": formatTime(
					this.startHour ?? 0,
					this.startMinute ?? 0,
				),
				"end time": formatTime(
					this.stopHour ?? 0,
					this.stopMinute ?? 0,
				),
			};
		}
		return {
			...super.toLogEntry(ctx),
			message,
		};
	}
}

// @publicAPI
export type ScheduleEntryLockCCWeekDayScheduleReportOptions =
	& ScheduleEntryLockSlotId
	& AllOrNone<ScheduleEntryLockWeekDaySchedule>;

@CCCommand(ScheduleEntryLockCommand.WeekDayScheduleReport)
export class ScheduleEntryLockCCWeekDayScheduleReport
	extends ScheduleEntryLockCC
{
	public constructor(
		options: WithAddress<ScheduleEntryLockCCWeekDayScheduleReportOptions>,
	) {
		super(options);
		this.userId = options.userId;
		this.slotId = options.slotId;
		this.weekday = options.weekday;
		this.startHour = options.startHour;
		this.startMinute = options.startMinute;
		this.stopHour = options.stopHour;
		this.stopMinute = options.stopMinute;
	}

	public static from(
		raw: CCRaw,
		ctx: CCParsingContext,
	): ScheduleEntryLockCCWeekDayScheduleReport {
		validatePayload(raw.payload.length >= 2);
		const userId = raw.payload[0];
		const slotId = raw.payload[1];

		let ccOptions: ScheduleEntryLockCCWeekDayScheduleReportOptions = {
			userId,
			slotId,
		};

		let weekday: ScheduleEntryLockWeekday | undefined;
		let startHour: number | undefined;
		let startMinute: number | undefined;
		let stopHour: number | undefined;
		let stopMinute: number | undefined;

		if (raw.payload.length >= 7) {
			if (raw.payload[2] !== 0xff) {
				weekday = raw.payload[2];
			}
			if (raw.payload[3] !== 0xff) {
				startHour = raw.payload[3];
			}
			if (raw.payload[4] !== 0xff) {
				startMinute = raw.payload[4];
			}
			if (raw.payload[5] !== 0xff) {
				stopHour = raw.payload[5];
			}
			if (raw.payload[6] !== 0xff) {
				stopMinute = raw.payload[6];
			}
		}

		if (
			weekday != undefined
			&& startHour != undefined
			&& startMinute != undefined
			&& stopHour != undefined
			&& stopMinute != undefined
		) {
			ccOptions = {
				...ccOptions,
				weekday,
				startHour,
				startMinute,
				stopHour,
				stopMinute,
			};
		}

		return new this({
			nodeId: ctx.sourceNodeId,
			...ccOptions,
		});
	}

	public userId: number;
	public slotId: number;
	public weekday?: ScheduleEntryLockWeekday;
	public startHour?: number;
	public startMinute?: number;
	public stopHour?: number;
	public stopMinute?: number;

	public persistValues(ctx: PersistValuesContext): boolean {
		if (!super.persistValues(ctx)) return false;

		persistSchedule.call(
			this,
			ctx,
			ScheduleEntryLockScheduleKind.WeekDay,
			this.userId,
			this.slotId,
			this.weekday != undefined
				? {
					weekday: this.weekday,
					startHour: this.startHour!,
					startMinute: this.startMinute!,
					stopHour: this.stopHour!,
					stopMinute: this.stopMinute!,
				}
				: false,
		);

		return true;
	}

	public serialize(ctx: CCEncodingContext): Promise<Bytes> {
		this.payload = Bytes.from([
			this.userId,
			this.slotId,
			this.weekday ?? 0xff,
			this.startHour ?? 0xff,
			this.startMinute ?? 0xff,
			this.stopHour ?? 0xff,
			this.stopMinute ?? 0xff,
		]);
		return super.serialize(ctx);
	}

	public toLogEntry(ctx?: GetValueDB): MessageOrCCLogEntry {
		let message: MessageRecord;
		if (this.weekday == undefined) {
			message = {
				"user ID": this.userId,
				"slot #": this.slotId,
				schedule: "(empty)",
			};
		} else {
			message = {
				"user ID": this.userId,
				"slot #": this.slotId,
				weekday: getEnumMemberName(
					ScheduleEntryLockWeekday,
					this.weekday,
				),
				"start time": formatTime(
					this.startHour ?? 0,
					this.startMinute ?? 0,
				),
				"end time": formatTime(
					this.stopHour ?? 0,
					this.stopMinute ?? 0,
				),
			};
		}
		return {
			...super.toLogEntry(ctx),
			message,
		};
	}
}

// @publicAPI
export type ScheduleEntryLockCCWeekDayScheduleGetOptions =
	ScheduleEntryLockSlotId;

@CCCommand(ScheduleEntryLockCommand.WeekDayScheduleGet)
@expectedCCResponse(ScheduleEntryLockCCWeekDayScheduleReport)
export class ScheduleEntryLockCCWeekDayScheduleGet extends ScheduleEntryLockCC {
	public constructor(
		options: WithAddress<ScheduleEntryLockCCWeekDayScheduleGetOptions>,
	) {
		super(options);
		this.userId = options.userId;
		this.slotId = options.slotId;
	}

	public static from(
		raw: CCRaw,
		ctx: CCParsingContext,
	): ScheduleEntryLockCCWeekDayScheduleGet {
		validatePayload(raw.payload.length >= 2);
		const userId = raw.payload[0];
		const slotId = raw.payload[1];

		return new this({
			nodeId: ctx.sourceNodeId,
			userId,
			slotId,
		});
	}

	public userId: number;
	public slotId: number;

	public serialize(ctx: CCEncodingContext): Promise<Bytes> {
		this.payload = Bytes.from([this.userId, this.slotId]);
		return super.serialize(ctx);
	}

	public toLogEntry(ctx?: GetValueDB): MessageOrCCLogEntry {
		return {
			...super.toLogEntry(ctx),
			message: {
				"user ID": this.userId,
				"slot #": this.slotId,
			},
		};
	}
}

/** @publicAPI */
export type ScheduleEntryLockCCYearDayScheduleSetOptions =
	& ScheduleEntryLockSlotId
	& (
		| {
			action: ScheduleEntryLockSetAction.Erase;
		}
		| ({
			action: ScheduleEntryLockSetAction.Set;
		} & ScheduleEntryLockYearDaySchedule)
	);

@CCCommand(ScheduleEntryLockCommand.YearDayScheduleSet)
@useSupervision()
export class ScheduleEntryLockCCYearDayScheduleSet extends ScheduleEntryLockCC {
	public constructor(
		options: WithAddress<ScheduleEntryLockCCYearDayScheduleSetOptions>,
	) {
		super(options);
		this.userId = options.userId;
		this.slotId = options.slotId;
		this.action = options.action;
		if (options.action === ScheduleEntryLockSetAction.Set) {
			this.startYear = options.startYear;
			this.startMonth = options.startMonth;
			this.startDay = options.startDay;
			this.startHour = options.startHour;
			this.startMinute = options.startMinute;
			this.stopYear = options.stopYear;
			this.stopMonth = options.stopMonth;
			this.stopDay = options.stopDay;
			this.stopHour = options.stopHour;
			this.stopMinute = options.stopMinute;
		}
	}

	public static from(
		raw: CCRaw,
		ctx: CCParsingContext,
	): ScheduleEntryLockCCYearDayScheduleSet {
		validatePayload(raw.payload.length >= 3);
		const action: ScheduleEntryLockSetAction = raw.payload[0];

		validatePayload(
			action === ScheduleEntryLockSetAction.Set
				|| action === ScheduleEntryLockSetAction.Erase,
		);
		const userId = raw.payload[1];
		const slotId = raw.payload[2];

		if (action !== ScheduleEntryLockSetAction.Set) {
			return new this({
				nodeId: ctx.sourceNodeId,
				action,
				userId,
				slotId,
			});
		}

		validatePayload(raw.payload.length >= 13);
		const startYear = raw.payload[3];
		const startMonth = raw.payload[4];
		const startDay = raw.payload[5];
		const startHour = raw.payload[6];
		const startMinute = raw.payload[7];
		const stopYear = raw.payload[8];
		const stopMonth = raw.payload[9];
		const stopDay = raw.payload[10];
		const stopHour = raw.payload[11];
		const stopMinute = raw.payload[12];

		return new this({
			nodeId: ctx.sourceNodeId,
			action,
			userId,
			slotId,
			startYear,
			startMonth,
			startDay,
			startHour,
			startMinute,
			stopYear,
			stopMonth,
			stopDay,
			stopHour,
			stopMinute,
		});
	}

	public userId: number;
	public slotId: number;

	public action: ScheduleEntryLockSetAction;

	public startYear?: number;
	public startMonth?: number;
	public startDay?: number;
	public startHour?: number;
	public startMinute?: number;
	public stopYear?: number;
	public stopMonth?: number;
	public stopDay?: number;
	public stopHour?: number;
	public stopMinute?: number;

	public serialize(ctx: CCEncodingContext): Promise<Bytes> {
		this.payload = Bytes.from([
			this.action,
			this.userId,
			this.slotId,
			// The report should have these fields set to 0xff
			// if the slot is erased. The specs don't mention anything
			// for the Set command, so we just assume the same is okay
			this.startYear ?? 0xff,
			this.startMonth ?? 0xff,
			this.startDay ?? 0xff,
			this.startHour ?? 0xff,
			this.startMinute ?? 0xff,
			this.stopYear ?? 0xff,
			this.stopMonth ?? 0xff,
			this.stopDay ?? 0xff,
			this.stopHour ?? 0xff,
			this.stopMinute ?? 0xff,
		]);
		return super.serialize(ctx);
	}

	public toLogEntry(ctx?: GetValueDB): MessageOrCCLogEntry {
		let message: MessageRecord;
		if (this.action === ScheduleEntryLockSetAction.Erase) {
			message = {
				"user ID": this.userId,
				"slot #": this.slotId,
				action: "erase",
			};
		} else {
			message = {
				"user ID": this.userId,
				"slot #": this.slotId,
				action: "set",
				"start date": `${
					formatDate(
						this.startYear ?? 0,
						this.startMonth ?? 0,
						this.startDay ?? 0,
					)
				} ${formatTime(this.startHour ?? 0, this.startMinute ?? 0)}`,
				"end date": `${
					formatDate(
						this.stopYear ?? 0,
						this.stopMonth ?? 0,
						this.stopDay ?? 0,
					)
				} ${formatTime(this.stopHour ?? 0, this.stopMinute ?? 0)}`,
			};
		}
		return {
			...super.toLogEntry(ctx),
			message,
		};
	}
}

// @publicAPI
export type ScheduleEntryLockCCYearDayScheduleReportOptions =
	& ScheduleEntryLockSlotId
	& AllOrNone<ScheduleEntryLockYearDaySchedule>;

@CCCommand(ScheduleEntryLockCommand.YearDayScheduleReport)
export class ScheduleEntryLockCCYearDayScheduleReport
	extends ScheduleEntryLockCC
{
	public constructor(
		options: WithAddress<ScheduleEntryLockCCYearDayScheduleReportOptions>,
	) {
		super(options);
		this.userId = options.userId;
		this.slotId = options.slotId;
		this.startYear = options.startYear;
		this.startMonth = options.startMonth;
		this.startDay = options.startDay;
		this.startHour = options.startHour;
		this.startMinute = options.startMinute;
		this.stopYear = options.stopYear;
		this.stopMonth = options.stopMonth;
		this.stopDay = options.stopDay;
		this.stopHour = options.stopHour;
		this.stopMinute = options.stopMinute;
	}

	public static from(
		raw: CCRaw,
		ctx: CCParsingContext,
	): ScheduleEntryLockCCYearDayScheduleReport {
		validatePayload(raw.payload.length >= 2);
		const userId = raw.payload[0];
		const slotId = raw.payload[1];

		let ccOptions: ScheduleEntryLockCCYearDayScheduleReportOptions = {
			userId,
			slotId,
		};

		let startYear: number | undefined;
		let startMonth: number | undefined;
		let startDay: number | undefined;
		let startHour: number | undefined;
		let startMinute: number | undefined;
		let stopYear: number | undefined;
		let stopMonth: number | undefined;
		let stopDay: number | undefined;
		let stopHour: number | undefined;
		let stopMinute: number | undefined;

		if (raw.payload.length >= 12) {
			if (raw.payload[2] !== 0xff) {
				startYear = raw.payload[2];
			}
			if (raw.payload[3] !== 0xff) {
				startMonth = raw.payload[3];
			}
			if (raw.payload[4] !== 0xff) {
				startDay = raw.payload[4];
			}
			if (raw.payload[5] !== 0xff) {
				startHour = raw.payload[5];
			}
			if (raw.payload[6] !== 0xff) {
				startMinute = raw.payload[6];
			}
			if (raw.payload[7] !== 0xff) {
				stopYear = raw.payload[7];
			}
			if (raw.payload[8] !== 0xff) {
				stopMonth = raw.payload[8];
			}
			if (raw.payload[9] !== 0xff) {
				stopDay = raw.payload[9];
			}
			if (raw.payload[10] !== 0xff) {
				stopHour = raw.payload[10];
			}
			if (raw.payload[11] !== 0xff) {
				stopMinute = raw.payload[11];
			}
		}

		if (
			startYear != undefined
			&& startMonth != undefined
			&& startDay != undefined
			&& startHour != undefined
			&& startMinute != undefined
			&& stopYear != undefined
			&& stopMonth != undefined
			&& stopDay != undefined
			&& stopHour != undefined
			&& stopMinute != undefined
		) {
			ccOptions = {
				...ccOptions,
				startYear,
				startMonth,
				startDay,
				startHour,
				startMinute,
				stopYear,
				stopMonth,
				stopDay,
				stopHour,
				stopMinute,
			};
		}

		return new this({
			nodeId: ctx.sourceNodeId,
			...ccOptions,
		});
	}

	public userId: number;
	public slotId: number;
	public startYear?: number;
	public startMonth?: number;
	public startDay?: number;
	public startHour?: number;
	public startMinute?: number;
	public stopYear?: number;
	public stopMonth?: number;
	public stopDay?: number;
	public stopHour?: number;
	public stopMinute?: number;

	public persistValues(ctx: PersistValuesContext): boolean {
		if (!super.persistValues(ctx)) return false;

		persistSchedule.call(
			this,
			ctx,
			ScheduleEntryLockScheduleKind.YearDay,
			this.userId,
			this.slotId,
			this.startYear != undefined
				? {
					startYear: this.startYear,
					startMonth: this.startMonth!,
					startDay: this.startDay!,
					startHour: this.startHour!,
					startMinute: this.startMinute!,
					stopYear: this.stopYear!,
					stopMonth: this.stopMonth!,
					stopDay: this.stopDay!,
					stopHour: this.stopHour!,
					stopMinute: this.stopMinute!,
				}
				: false,
		);

		return true;
	}

	public serialize(ctx: CCEncodingContext): Promise<Bytes> {
		this.payload = Bytes.from([
			this.userId,
			this.slotId,
			this.startYear ?? 0xff,
			this.startMonth ?? 0xff,
			this.startDay ?? 0xff,
			this.startHour ?? 0xff,
			this.startMinute ?? 0xff,
			this.stopYear ?? 0xff,
			this.stopMonth ?? 0xff,
			this.stopDay ?? 0xff,
			this.stopHour ?? 0xff,
			this.stopMinute ?? 0xff,
		]);
		return super.serialize(ctx);
	}

	public toLogEntry(ctx?: GetValueDB): MessageOrCCLogEntry {
		let message: MessageRecord;
		if (this.startYear !== undefined) {
			message = {
				"user ID": this.userId,
				"slot #": this.slotId,
				schedule: "(empty)",
			};
		} else {
			message = {
				"user ID": this.userId,
				"slot #": this.slotId,
				action: "set",
				"start date": `${
					formatDate(
						this.startYear ?? 0,
						this.startMonth ?? 0,
						this.startDay ?? 0,
					)
				} ${formatTime(this.startHour ?? 0, this.startMinute ?? 0)}`,
				"end date": `${
					formatDate(
						this.stopYear ?? 0,
						this.stopMonth ?? 0,
						this.stopDay ?? 0,
					)
				} ${formatTime(this.stopHour ?? 0, this.stopMinute ?? 0)}`,
			};
		}
		return {
			...super.toLogEntry(ctx),
			message,
		};
	}
}

// @publicAPI
export type ScheduleEntryLockCCYearDayScheduleGetOptions =
	ScheduleEntryLockSlotId;

@CCCommand(ScheduleEntryLockCommand.YearDayScheduleGet)
@expectedCCResponse(ScheduleEntryLockCCYearDayScheduleReport)
export class ScheduleEntryLockCCYearDayScheduleGet extends ScheduleEntryLockCC {
	public constructor(
		options: WithAddress<ScheduleEntryLockCCYearDayScheduleGetOptions>,
	) {
		super(options);
		this.userId = options.userId;
		this.slotId = options.slotId;
	}

	public static from(
		raw: CCRaw,
		ctx: CCParsingContext,
	): ScheduleEntryLockCCYearDayScheduleGet {
		validatePayload(raw.payload.length >= 2);
		const userId = raw.payload[0];
		const slotId = raw.payload[1];

		return new this({
			nodeId: ctx.sourceNodeId,
			userId,
			slotId,
		});
	}

	public userId: number;
	public slotId: number;

	public serialize(ctx: CCEncodingContext): Promise<Bytes> {
		this.payload = Bytes.from([this.userId, this.slotId]);
		return super.serialize(ctx);
	}

	public toLogEntry(ctx?: GetValueDB): MessageOrCCLogEntry {
		return {
			...super.toLogEntry(ctx),
			message: {
				"user ID": this.userId,
				"slot #": this.slotId,
			},
		};
	}
}

// @publicAPI
export interface ScheduleEntryLockCCTimeOffsetSetOptions {
	standardOffset: number;
	dstOffset: number;
}

@CCCommand(ScheduleEntryLockCommand.TimeOffsetSet)
@useSupervision()
export class ScheduleEntryLockCCTimeOffsetSet extends ScheduleEntryLockCC {
	public constructor(
		options: WithAddress<ScheduleEntryLockCCTimeOffsetSetOptions>,
	) {
		super(options);
		this.standardOffset = options.standardOffset;
		this.dstOffset = options.dstOffset;
	}

	public static from(
		raw: CCRaw,
		ctx: CCParsingContext,
	): ScheduleEntryLockCCTimeOffsetSet {
		const { standardOffset, dstOffset } = parseTimezone(raw.payload);

		return new this({
			nodeId: ctx.sourceNodeId,
			standardOffset,
			dstOffset,
		});
	}

	public standardOffset: number;
	public dstOffset: number;

	public serialize(ctx: CCEncodingContext): Promise<Bytes> {
		this.payload = encodeTimezone({
			standardOffset: this.standardOffset,
			dstOffset: this.dstOffset,
		});
		return super.serialize(ctx);
	}

	public toLogEntry(ctx?: GetValueDB): MessageOrCCLogEntry {
		return {
			...super.toLogEntry(ctx),
			message: {
				"standard time offset": `${this.standardOffset} minutes`,
				"DST offset": `${this.dstOffset} minutes`,
			},
		};
	}
}

// @publicAPI
export interface ScheduleEntryLockCCTimeOffsetReportOptions {
	standardOffset: number;
	dstOffset: number;
}

@CCCommand(ScheduleEntryLockCommand.TimeOffsetReport)
export class ScheduleEntryLockCCTimeOffsetReport extends ScheduleEntryLockCC {
	public constructor(
		options: WithAddress<ScheduleEntryLockCCTimeOffsetReportOptions>,
	) {
		super(options);
		this.standardOffset = options.standardOffset;
		this.dstOffset = options.dstOffset;
	}

	public static from(
		raw: CCRaw,
		ctx: CCParsingContext,
	): ScheduleEntryLockCCTimeOffsetReport {
		const { standardOffset, dstOffset } = parseTimezone(raw.payload);

		return new this({
			nodeId: ctx.sourceNodeId,
			standardOffset,
			dstOffset,
		});
	}

	public standardOffset: number;
	public dstOffset: number;

	public serialize(ctx: CCEncodingContext): Promise<Bytes> {
		this.payload = encodeTimezone({
			standardOffset: this.standardOffset,
			dstOffset: this.dstOffset,
		});
		return super.serialize(ctx);
	}

	public toLogEntry(ctx?: GetValueDB): MessageOrCCLogEntry {
		return {
			...super.toLogEntry(ctx),
			message: {
				"standard time offset": `${this.standardOffset} minutes`,
				"DST offset": `${this.dstOffset} minutes`,
			},
		};
	}
}

@CCCommand(ScheduleEntryLockCommand.TimeOffsetGet)
@expectedCCResponse(ScheduleEntryLockCCTimeOffsetReport)
export class ScheduleEntryLockCCTimeOffsetGet extends ScheduleEntryLockCC {}

/** @publicAPI */
export type ScheduleEntryLockCCDailyRepeatingScheduleSetOptions =
	& ScheduleEntryLockSlotId
	& (
		| {
			action: ScheduleEntryLockSetAction.Erase;
		}
		| ({
			action: ScheduleEntryLockSetAction.Set;
		} & ScheduleEntryLockDailyRepeatingSchedule)
	);

@CCCommand(ScheduleEntryLockCommand.DailyRepeatingScheduleSet)
@useSupervision()
export class ScheduleEntryLockCCDailyRepeatingScheduleSet
	extends ScheduleEntryLockCC
{
	public constructor(
		options: WithAddress<
			ScheduleEntryLockCCDailyRepeatingScheduleSetOptions
		>,
	) {
		super(options);
		this.userId = options.userId;
		this.slotId = options.slotId;
		this.action = options.action;
		if (options.action === ScheduleEntryLockSetAction.Set) {
			this.weekdays = options.weekdays;
			this.startHour = options.startHour;
			this.startMinute = options.startMinute;
			this.durationHour = options.durationHour;
			this.durationMinute = options.durationMinute;
		}
	}

	public static from(
		raw: CCRaw,
		ctx: CCParsingContext,
	): ScheduleEntryLockCCDailyRepeatingScheduleSet {
		validatePayload(raw.payload.length >= 3);
		const action: ScheduleEntryLockSetAction = raw.payload[0];

		validatePayload(
			action === ScheduleEntryLockSetAction.Set
				|| action === ScheduleEntryLockSetAction.Erase,
		);
		const userId = raw.payload[1];
		const slotId = raw.payload[2];

		if (action !== ScheduleEntryLockSetAction.Set) {
			return new this({
				nodeId: ctx.sourceNodeId,
				action,
				userId,
				slotId,
			});
		}

		validatePayload(raw.payload.length >= 8);
		const weekdays: ScheduleEntryLockWeekday[] = parseBitMask(
			raw.payload.subarray(3, 4),
			ScheduleEntryLockWeekday.Sunday,
		);
		const startHour = raw.payload[4];
		const startMinute = raw.payload[5];
		const durationHour = raw.payload[6];
		const durationMinute = raw.payload[7];

		return new this({
			nodeId: ctx.sourceNodeId,
			action,
			userId,
			slotId,
			weekdays,
			startHour,
			startMinute,
			durationHour,
			durationMinute,
		});
	}

	public userId: number;
	public slotId: number;

	public action: ScheduleEntryLockSetAction;

	public weekdays?: ScheduleEntryLockWeekday[];
	public startHour?: number;
	public startMinute?: number;
	public durationHour?: number;
	public durationMinute?: number;

	public serialize(ctx: CCEncodingContext): Promise<Bytes> {
		this.payload = Bytes.from([this.action, this.userId, this.slotId]);
		if (this.action === ScheduleEntryLockSetAction.Set) {
			this.payload = Bytes.concat([
				this.payload,
				encodeBitMask(
					this.weekdays!,
					ScheduleEntryLockWeekday.Saturday,
					ScheduleEntryLockWeekday.Sunday,
				),
				Bytes.from([
					this.startHour!,
					this.startMinute!,
					this.durationHour!,
					this.durationMinute!,
				]),
			]);
		} else {
			// Not sure if this is correct
			this.payload = Bytes.concat([this.payload, Bytes.alloc(5, 0xff)]);
		}

		return super.serialize(ctx);
	}

	public toLogEntry(ctx?: GetValueDB): MessageOrCCLogEntry {
		let message: MessageRecord;
		if (this.action === ScheduleEntryLockSetAction.Erase) {
			message = {
				"user ID": this.userId,
				"slot #": this.slotId,
				action: "erase",
			};
		} else {
			message = {
				"user ID": this.userId,
				"slot #": this.slotId,
				action: "set",
				weekdays: this.weekdays!.map((w) =>
					getEnumMemberName(ScheduleEntryLockWeekday, w)
				).join(", "),
				"start time": formatTime(
					this.startHour ?? 0,
					this.startMinute ?? 0,
				),
				duration: formatTime(
					this.durationHour ?? 0,
					this.durationMinute ?? 0,
				),
			};
		}
		return {
			...super.toLogEntry(ctx),
			message,
		};
	}
}

// @publicAPI
export type ScheduleEntryLockCCDailyRepeatingScheduleReportOptions =
	& ScheduleEntryLockSlotId
	& AllOrNone<ScheduleEntryLockDailyRepeatingSchedule>;

@CCCommand(ScheduleEntryLockCommand.DailyRepeatingScheduleReport)
export class ScheduleEntryLockCCDailyRepeatingScheduleReport
	extends ScheduleEntryLockCC
{
	public constructor(
		options: WithAddress<
			ScheduleEntryLockCCDailyRepeatingScheduleReportOptions
		>,
	) {
		super(options);
		this.userId = options.userId;
		this.slotId = options.slotId;
		this.weekdays = options.weekdays;
		this.startHour = options.startHour;
		this.startMinute = options.startMinute;
		this.durationHour = options.durationHour;
		this.durationMinute = options.durationMinute;
	}

	public static from(
		raw: CCRaw,
		ctx: CCParsingContext,
	): ScheduleEntryLockCCDailyRepeatingScheduleReport {
		validatePayload(raw.payload.length >= 2);
		const userId = raw.payload[0];
		const slotId = raw.payload[1];

		if (raw.payload.length >= 7 && raw.payload[2] !== 0) {
			// Only parse the schedule if it is present and some weekday is selected
			const weekdays: ScheduleEntryLockWeekday[] = parseBitMask(
				raw.payload.subarray(2, 3),
				ScheduleEntryLockWeekday.Sunday,
			);
			const startHour = raw.payload[3];
			const startMinute = raw.payload[4];
			const durationHour = raw.payload[5];
			const durationMinute = raw.payload[6];

			return new this({
				nodeId: ctx.sourceNodeId,
				userId,
				slotId,
				weekdays,
				startHour,
				startMinute,
				durationHour,
				durationMinute,
			});
		} else {
			return new this({
				nodeId: ctx.sourceNodeId,
				userId,
				slotId,
			});
		}
	}

	public userId: number;
	public slotId: number;

	public weekdays?: ScheduleEntryLockWeekday[];
	public startHour?: number;
	public startMinute?: number;
	public durationHour?: number;
	public durationMinute?: number;

	public persistValues(ctx: PersistValuesContext): boolean {
		if (!super.persistValues(ctx)) return false;

		persistSchedule.call(
			this,
			ctx,
			ScheduleEntryLockScheduleKind.DailyRepeating,
			this.userId,
			this.slotId,
			this.weekdays?.length
				? {
					weekdays: this.weekdays,
					startHour: this.startHour!,
					startMinute: this.startMinute!,
					durationHour: this.durationHour!,
					durationMinute: this.durationMinute!,
				}
				: false,
		);

		return true;
	}

	public serialize(ctx: CCEncodingContext): Promise<Bytes> {
		this.payload = Bytes.from([this.userId, this.slotId]);
		if (this.weekdays) {
			this.payload = Bytes.concat([
				this.payload,
				encodeBitMask(
					this.weekdays,
					ScheduleEntryLockWeekday.Saturday,
					ScheduleEntryLockWeekday.Sunday,
				),
				Bytes.from([
					this.startHour!,
					this.startMinute!,
					this.durationHour!,
					this.durationMinute!,
				]),
			]);
		} else {
			// Not sure if this is correct, but at least we won't parse it incorrectly ourselves when setting everything to 0
			this.payload = Bytes.concat([this.payload, Bytes.alloc(5, 0)]);
		}

		return super.serialize(ctx);
	}

	public toLogEntry(ctx?: GetValueDB): MessageOrCCLogEntry {
		let message: MessageRecord;
		if (!this.weekdays) {
			message = {
				"user ID": this.userId,
				"slot #": this.slotId,
				schedule: "(empty)",
			};
		} else {
			message = {
				"user ID": this.userId,
				"slot #": this.slotId,
				action: "set",
				weekdays: this.weekdays
					.map((w) => getEnumMemberName(ScheduleEntryLockWeekday, w))
					.join(", "),
				"start time": formatTime(
					this.startHour ?? 0,
					this.startMinute ?? 0,
				),
				duration: formatTime(
					this.durationHour ?? 0,
					this.durationMinute ?? 0,
				),
			};
		}
		return {
			...super.toLogEntry(ctx),
			message,
		};
	}
}

// @publicAPI
export type ScheduleEntryLockCCDailyRepeatingScheduleGetOptions =
	ScheduleEntryLockSlotId;

@CCCommand(ScheduleEntryLockCommand.DailyRepeatingScheduleGet)
@expectedCCResponse(ScheduleEntryLockCCDailyRepeatingScheduleReport)
export class ScheduleEntryLockCCDailyRepeatingScheduleGet
	extends ScheduleEntryLockCC
{
	public constructor(
		options: WithAddress<
			ScheduleEntryLockCCDailyRepeatingScheduleGetOptions
		>,
	) {
		super(options);
		this.userId = options.userId;
		this.slotId = options.slotId;
	}

	public static from(
		raw: CCRaw,
		ctx: CCParsingContext,
	): ScheduleEntryLockCCDailyRepeatingScheduleGet {
		validatePayload(raw.payload.length >= 2);
		const userId = raw.payload[0];
		const slotId = raw.payload[1];

		return new this({
			nodeId: ctx.sourceNodeId,
			userId,
			slotId,
		});
	}

	public userId: number;
	public slotId: number;

	public serialize(ctx: CCEncodingContext): Promise<Bytes> {
		this.payload = Bytes.from([this.userId, this.slotId]);
		return super.serialize(ctx);
	}

	public toLogEntry(ctx?: GetValueDB): MessageOrCCLogEntry {
		return {
			...super.toLogEntry(ctx),
			message: {
				"user ID": this.userId,
				"slot #": this.slotId,
			},
		};
	}
}
