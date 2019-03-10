import * as React from 'react';
import * as jspb from 'google-protobuf';
import fz from 'fz';

import Button from 'grommet/components/Button';
import { CheckmarkIcon, SearchInput } from 'grommet';
import Loading from './Loading';
import CreateDeployment from './CreateDeployment';
import protoMapDiff, { applyProtoMapDiff, Diff, DiffOp } from './util/protoMapDiff';
import protoMapReplace from './util/protoMapReplace';
import withClient, { ClientProps } from './withClient';
import withErrorHandler, { ErrorHandlerProps } from './withErrorHandler';
import { Release } from './generated/controller_pb';

import './EnvEditor.scss';

export type Entries = jspb.Map<string, string>;

function entriesEqual(a: [string, string], b: [string, string]): boolean {
	return a && b && a[0] === b[0] && a[1] === b[1];
}

interface EnvStateInternalState {
	originalEntries: Entries;
	uniqueKeyMap: { [key: string]: number };
	filterText: string;
	deletedIndices: { [key: number]: boolean };
	changedIndices: { [key: number]: boolean };
}

export class EnvState {
	public length: number;
	public deletedLength: number;
	public hasChanges: boolean;
	private _entries: Entries;
	private _state: EnvStateInternalState;
	constructor(entries: Entries, state: EnvStateInternalState | null = null) {
		this._entries = entries;
		this._state = state
			? state
			: {
					originalEntries: entries,
					changedIndices: {},
					deletedIndices: {},
					uniqueKeyMap: entries
						.toArray()
						.reduce((m: { [key: string]: number }, [key, value]: [string, string], index: number) => {
							m[key] = index;
							return m;
						}, {}),
					filterText: ''
			  };
		this.length = entries.getLength();
		this._setDeletedLength();
	}

	public dup(): EnvState {
		return new EnvState(this._entries, Object.assign({}, this._state));
	}

	public filtered(filterText: string): EnvState {
		return new EnvState(this._entries, Object.assign({}, this._state, { filterText }));
	}

	public get(key: string): string | undefined {
		return this._entries.get(key);
	}

	public entries(): Entries {
		return new jspb.Map(
			this._entries.toArray().filter(
				(entry: [string, string], index: number): boolean => {
					return this._state.deletedIndices[index] !== true && entry[0] !== '' && entry[1] !== '';
				}
			)
		);
	}

	public map<T>(fn: (entry: [string, string], index: number) => T): T[] {
		const filterText = this._state.filterText;
		return (
			this._entries
				.toArray()
				.reduce<T[]>(
					(prev: T[], entry: [string, string], index: number): T[] => {
						if (this._state.deletedIndices[index] === true) {
							return prev;
						}
						if (filterText && !fz(entry[0], filterText)) {
							return prev;
						}
						return prev.concat(fn(entry, index));
					},
					[] as Array<T>
				)
				// there's always an empty entry at the end for adding new env
				.concat(fn(['', ''], this.length))
		);
	}

	public mapDeleted<T>(fn: (entry: [string, string], index: number) => T): T[] {
		return this._entries.toArray().reduce<T[]>(
			(prev: T[], entry: [string, string], index: number): T[] => {
				if (this._state.deletedIndices[index] !== true) {
					return prev;
				}
				return prev.concat(fn(entry, index));
			},
			[] as Array<T>
		);
	}

	public applyDiff(diff: Diff<string, string>) {
		diff.forEach((op: DiffOp<string, string>) => {
			let index = this._entries.toArray().findIndex(([key, value]: [string, string]) => {
				return key === op.key;
			});
			switch (op.op) {
				case 'add':
					if (op.value) {
						if (index === -1) {
							index = this._entries.toArray().length;
						}
						this.setKeyAtIndex(index, op.key);
						this.setValueAtIndex(index, op.value);
					}
					break;
				case 'remove':
					if (index !== -1) {
						this.removeEntryAtIndex(index);
					}
					break;
			}
		});
	}

	public setKeyAtIndex(index: number, key: string) {
		delete this._state.deletedIndices[index]; // allow restoring an item
		this._setDeletedLength();
		const entries = this._entries.toArray().slice(); // don't modify old map
		entries[index] = [key, (entries[index] || [])[1] || ''];
		this.length = entries.length;
		this._entries = new jspb.Map(entries);
		this._trackChanges(index);
		if (this._state.uniqueKeyMap[key] > -1 && this._state.uniqueKeyMap[key] !== index && index < entries.length) {
			// duplicate key, remove old one
			this.removeEntryAtIndex(this._state.uniqueKeyMap[key]);
			this._state.uniqueKeyMap[key] = index;
		}
	}

	public setValueAtIndex(index: number, val: string) {
		const entries = this._entries.toArray().slice(); // don't modify old map
		entries[index] = [(entries[index] || [])[0] || '', val];
		this.length = entries.length;
		this._entries = new jspb.Map(entries);
		if (val === '' && (entries[index] || [])[0] === '') {
			// if there's no key or value, remove it
			this.removeEntryAtIndex(index);
		} else {
			this._trackChanges(index);
		}
	}

	public removeEntryAtIndex(index: number) {
		this._state.deletedIndices[index] = true;
		this._setDeletedLength();
		this._trackChanges(index);
	}

	private _trackChanges(index: number) {
		const { deletedIndices, changedIndices, originalEntries } = this._state;
		if (deletedIndices[index] === true) {
			if (index < originalEntries.getLength()) {
				changedIndices[index] = true;
			} else {
				delete changedIndices[index];
			}
		} else if (entriesEqual(originalEntries.toArray()[index], this._entries.toArray()[index])) {
			delete changedIndices[index];
		} else {
			changedIndices[index] = true;
		}
		this.hasChanges = Object.keys(changedIndices).length > 0;
	}

	private _setDeletedLength() {
		this.deletedLength = Object.keys(this._state.deletedIndices).length;
	}
}

interface EnvInputProps {
	placeholder: string;
	value: string;
	onChange: (value: string) => void;
	disabled?: boolean;
}

interface EnvInputState {
	expanded: boolean;
	multiline: boolean;
}

class EnvInput extends React.Component<EnvInputProps, EnvInputState> {
	private _textarea: HTMLTextAreaElement | null;

	constructor(props: EnvInputProps) {
		super(props);
		this.state = {
			expanded: false,
			multiline: props.value.indexOf('\n') >= 0
		};
		this._inputChangeHandler = this._inputChangeHandler.bind(this);
		this._inputFocusHandler = this._inputFocusHandler.bind(this);
		this._textareaBlurHandler = this._textareaBlurHandler.bind(this);
		this._textareaChangeHandler = this._textareaChangeHandler.bind(this);
		this._textarea = null;
	}

	public componentDidUpdate(prevProps: EnvInputProps, prevState: EnvInputState) {
		if (!prevState.expanded && this.state.expanded && this._textarea) {
			this._textarea.focus();
		}
	}

	public render() {
		const { placeholder, value, disabled } = this.props;
		const { expanded } = this.state;
		if (expanded) {
			return (
				<textarea
					value={value}
					onChange={this._textareaChangeHandler}
					onBlur={this._textareaBlurHandler}
					ref={(el) => {
						this._textarea = el;
					}}
				/>
			);
		}
		return (
			<input
				type="text"
				disabled={disabled}
				placeholder={placeholder}
				value={value}
				onChange={this._inputChangeHandler}
				onFocus={this._inputFocusHandler}
			/>
		);
	}

	private _inputChangeHandler(e: React.ChangeEvent<HTMLInputElement>) {
		const value = e.target.value || '';
		this.props.onChange(value);
	}

	private _textareaChangeHandler(e: React.ChangeEvent<HTMLTextAreaElement>) {
		const value = e.target.value || '';
		this.props.onChange(value);
	}

	private _inputFocusHandler() {
		if (this.state.multiline) {
			this.setState({
				expanded: true
			});
		}
	}

	private _textareaBlurHandler() {
		if (this.state.expanded) {
			this.setState({
				expanded: false
			});
		}
	}
}

export interface Props {
	entries: EnvState;
	onChange: (entries: EnvState) => void;
	onSubmit: (entries: EnvState) => void;
}

interface State {}

class EnvEditor extends React.Component<Props, State> {
	constructor(props: Props) {
		super(props);
		this.state = {};
		this._searchInputHandler = this._searchInputHandler.bind(this);
		this._submitHandler = this._submitHandler.bind(this);
	}

	public render() {
		const { entries } = this.props;

		return (
			<form onSubmit={this._submitHandler} className="env-editor">
				<SearchInput onDOMChange={this._searchInputHandler} />
				{entries.map(([key, value]: [string, string], index: number) => {
					return (
						<div key={index} className="env-row">
							<EnvInput placeholder="ENV key" value={key} onChange={this._keyChangeHandler.bind(this, index)} />
							<EnvInput placeholder="ENV value" value={value} onChange={this._valueChangeHandler.bind(this, index)} />
						</div>
					);
				})}
				{entries.hasChanges ? (
					// Enable save button
					<Button type="submit" primary icon={<CheckmarkIcon />} label="Review Changes" />
				) : (
					// Disable save button
					<Button type="button" primary icon={<CheckmarkIcon />} label="Review Changes" />
				)}
			</form>
		);
	}

	private _keyChangeHandler(index: number, key: string) {
		let nextEntries = this.props.entries.dup();
		if (key.length > 0) {
			nextEntries.setKeyAtIndex(index, key);
		} else {
			nextEntries.removeEntryAtIndex(index);
		}
		this.props.onChange(nextEntries);
	}

	private _valueChangeHandler(index: number, value: string) {
		let nextEntries = this.props.entries.dup();
		nextEntries.setValueAtIndex(index, value);
		this.props.onChange(nextEntries);
	}

	private _searchInputHandler(e: React.ChangeEvent<HTMLInputElement>) {
		const value = e.target.value || '';
		this.props.onChange(this.props.entries.filtered(value));
	}

	private _submitHandler(e: React.SyntheticEvent) {
		e.preventDefault();
		this.props.onSubmit(this.props.entries);
	}
}

interface WrappedProps extends ClientProps, ErrorHandlerProps {
	appName: string;
}

interface WrappedState {
	release: Release | null;
	isLoading: boolean;
	isDeploying: boolean;
	envState: EnvState | null;
}

class WrappedEnvEditor extends React.Component<WrappedProps, WrappedState> {
	private __streamAppReleaseCancel: () => void;
	constructor(props: WrappedProps) {
		super(props);
		this.state = {
			release: null,
			isLoading: true,
			isDeploying: false,
			envState: null
		};

		this.__streamAppReleaseCancel = () => {};
		this._getData = this._getData.bind(this);
		this._handleChange = this._handleChange.bind(this);
		this._handleSubmit = this._handleSubmit.bind(this);
		this._buildNewRelease = this._buildNewRelease.bind(this);
		this._handleDeployCancel = this._handleDeployCancel.bind(this);
		this._handleDeploymentCreate = this._handleDeploymentCreate.bind(this);
	}

	public componentDidMount() {
		this._getData();
	}

	public componentWillUnmount() {
		this.__streamAppReleaseCancel();
	}

	public render() {
		const { appName } = this.props;
		const { release, isLoading, isDeploying, envState } = this.state;
		if (isLoading) {
			return <Loading />;
		}
		if (isDeploying) {
			return (
				<CreateDeployment
					appName={appName}
					buildNewRelease={this._buildNewRelease}
					onCancel={this._handleDeployCancel}
					onCreate={this._handleDeploymentCreate}
				/>
			);
		}
		if (!release) throw new Error('Unexpected lack of release!');
		return (
			<EnvEditor
				entries={envState || new EnvState(release.getEnvMap())}
				onChange={this._handleChange}
				onSubmit={this._handleSubmit}
			/>
		);
	}

	private _getData() {
		const { client, appName, handleError } = this.props;
		this.setState({
			release: null,
			envState: null,
			isLoading: true
		});
		this.__streamAppReleaseCancel();
		this.__streamAppReleaseCancel = client.streamAppRelease(appName, (release: Release, error: Error | null) => {
			if (error) {
				return handleError(error);
			}

			// maintain any changes made
			const envState = new EnvState(release.getEnvMap());
			const prevEnvState = this.state.envState;
			const prevRelease = this.state.release;
			if (!prevRelease || prevRelease.getName() !== release.getName()) {
				if (prevEnvState && prevEnvState.hasChanges) {
					const envDiff = protoMapDiff(
						prevRelease ? prevRelease.getEnvMap() : new jspb.Map<string, string>([]),
						prevEnvState.entries()
					);
					if (envDiff.length) {
						envState.applyDiff(envDiff);
					}
				}
			}

			this.setState({
				release,
				envState,
				isLoading: false
			});
		});
	}

	private _handleChange(entries: EnvState) {
		this.setState({
			envState: entries
		});
	}

	private _handleSubmit(entries: EnvState) {
		this.setState({
			isDeploying: true,
			envState: entries
		});
	}

	private _buildNewRelease(currentRelease: Release): Release {
		const { envState } = this.state;
		if (!envState) throw new Error('_buildNewRelease invalid state!');
		const envDiff = protoMapDiff(currentRelease.getEnvMap(), envState.entries());
		const newRelease = new Release();
		newRelease.setArtifactsList(currentRelease.getArtifactsList());
		protoMapReplace(newRelease.getLabelsMap(), currentRelease.getLabelsMap());
		protoMapReplace(newRelease.getProcessesMap(), currentRelease.getProcessesMap());
		protoMapReplace(newRelease.getEnvMap(), applyProtoMapDiff(currentRelease.getEnvMap(), envDiff));
		return newRelease;
	}

	private _handleDeployCancel() {
		this.setState({
			isDeploying: false
		});
	}

	private _handleDeploymentCreate() {
		this.setState({
			isDeploying: false,
			envState: null
		});
	}
}

export default withErrorHandler(withClient(WrappedEnvEditor));
