import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { SecretsApi } from './api';
import type { SecretInfo } from '../main/vault';

const entry = (name: string, description = ''): SecretInfo => ({
  name,
  description,
  updatedAt: '2026-11-04T10:00:00.000Z',
});

function setup(initial: SecretInfo[] = []) {
  let push: (s: SecretInfo[]) => void = () => {};
  const api = {
    list: vi.fn(async () => initial),
    save: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    onState: (l: (s: SecretInfo[]) => void) => ((push = l), () => {}),
  } satisfies SecretsApi;
  render(<App api={api} />);
  return { api, push: (s: SecretInfo[]) => act(() => push(s)) };
}

const form = () => screen.getByRole('form', { name: 'Neues Passwort' });
async function fill(name: string, value: string, description = '') {
  const user = userEvent.setup();
  const f = within(form());
  if (name) await user.type(f.getByLabelText('Name'), name);
  if (value) await user.type(f.getByLabelText('Wert'), value);
  if (description) await user.type(f.getByLabelText('Beschreibung'), description);
  return user;
}

describe('secrets bay UI', () => {
  it('shows the empty state and the entries without values', async () => {
    const { push } = setup();
    expect(await screen.findByText('Noch keine Passwörter gespeichert.')).toBeTruthy();
    push([entry('GITHUB_TOKEN', 'CI')]);
    const row = screen.getByRole('listitem');
    expect(within(row).getByText('GITHUB_TOKEN')).toBeTruthy();
    expect(within(row).getByText('CI')).toBeTruthy();
  });

  // Form matrix: always exactly one field wrong.
  it('says the name is missing', async () => {
    const { api } = setup();
    const user = await fill('', 'geheim');
    await user.click(within(form()).getByRole('button', { name: 'Speichern' }));
    expect(within(form()).getByRole('alert').textContent).toBe('Name fehlt');
    expect(api.save).not.toHaveBeenCalled();
  });

  it('says the value is missing', async () => {
    const { api } = setup();
    const user = await fill('TOKEN', '');
    await user.click(within(form()).getByRole('button', { name: 'Speichern' }));
    expect(within(form()).getByRole('alert').textContent).toBe('Wert fehlt');
    expect(api.save).not.toHaveBeenCalled();
  });

  it('shows the error of the bay for an invalid name and keeps the input', async () => {
    const { api } = setup();
    api.save.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'bay:invoke': Error: Ungültiger Name: 1X (Buchstaben, Ziffern, _)",
      ),
    );
    const user = await fill('1X', 'geheim');
    await user.click(within(form()).getByRole('button', { name: 'Speichern' }));
    expect(within(form()).getByRole('alert').textContent).toBe(
      'Ungültiger Name: 1X (Buchstaben, Ziffern, _)',
    );
    expect((within(form()).getByLabelText('Name') as HTMLInputElement).value).toBe('1X');
  });

  it('shows the error of the bay for a too long description', async () => {
    const { api } = setup();
    api.save.mockRejectedValueOnce(new Error('Beschreibung zu lang (höchstens 200 Zeichen)'));
    const user = await fill('TOKEN', 'geheim', 'lang');
    await user.click(within(form()).getByRole('button', { name: 'Speichern' }));
    expect(within(form()).getByRole('alert').textContent).toBe(
      'Beschreibung zu lang (höchstens 200 Zeichen)',
    );
  });

  it('validates also on Enter', async () => {
    const { api } = setup();
    const user = await fill('TOKEN', '');
    await user.type(within(form()).getByLabelText('Name'), '{Enter}');
    expect(within(form()).getByRole('alert').textContent).toBe('Wert fehlt');
    expect(api.save).not.toHaveBeenCalled();
  });

  it('saves with Enter and clears the form, the value never shown', async () => {
    const { api } = setup();
    const user = await fill('TOKEN', 'geheim', 'CI');
    expect(within(form()).getByLabelText('Wert').getAttribute('type')).toBe('password');
    await user.type(within(form()).getByLabelText('Wert'), '{Enter}');
    expect(api.save).toHaveBeenCalledWith({ name: 'TOKEN', value: 'geheim', description: 'CI' });
    expect((within(form()).getByLabelText('Name') as HTMLInputElement).value).toBe('');
    expect((within(form()).getByLabelText('Wert') as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('status').textContent).toBe('TOKEN gespeichert');
  });

  it('replaces a value: empty is refused, a new one is saved with the description', async () => {
    const { api } = setup([entry('TOKEN', 'CI')]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Wert ersetzen: TOKEN' }));
    const field = screen.getByLabelText('Neuer Wert für TOKEN');
    expect(field).toBe(document.activeElement);
    await user.type(field, '{Enter}');
    expect(screen.getAllByRole('alert').at(-1)!.textContent).toBe('Wert fehlt');
    await user.type(field, 'neu{Enter}');
    expect(api.save).toHaveBeenCalledWith({ name: 'TOKEN', value: 'neu', description: 'CI' });
    expect(screen.queryByLabelText('Neuer Wert für TOKEN')).toBeNull();
  });

  it('cancels replacing with Escape', async () => {
    setup([entry('TOKEN')]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Wert ersetzen: TOKEN' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByLabelText('Neuer Wert für TOKEN')).toBeNull();
    expect(screen.getByRole('button', { name: 'Wert ersetzen: TOKEN' })).toBe(
      document.activeElement,
    );
  });

  it('deletes only after confirming', async () => {
    const { api } = setup([entry('TOKEN')]);
    const confirm = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const user = userEvent.setup();
    const button = await screen.findByRole('button', { name: 'TOKEN löschen' });
    await user.click(button);
    expect(api.remove).not.toHaveBeenCalled();
    await user.click(button);
    expect(confirm).toHaveBeenLastCalledWith(
      'TOKEN löschen? Shells, die darauf verweisen, starten danach nicht mehr.',
    );
    expect(api.remove).toHaveBeenCalledWith('TOKEN');
  });
  it('saves and deletes once for a double click (ADR 0028)', async () => {
    const { api } = setup([entry('OLD')]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await fill('TOKEN', 'geheim');
    const twice = async (name: string) => {
      const button = await screen.findByRole('button', { name });
      // The second click of a double click, after the first answer already came.
      fireEvent.click(button, { detail: 1 });
      fireEvent.click(button, { detail: 2 });
    };
    await twice('Speichern');
    await twice('OLD löschen');
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(api.remove).toHaveBeenCalledTimes(1);
  });
});
