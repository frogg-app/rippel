import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ManagedUser } from '@comfy/shared';
import { UsersSection } from './UsersSection';
const user: ManagedUser={id:'u1',email:'member@example.com',displayName:'Member',role:'user',createdAt:'',settingsAccess:false,suspended:false,generationEnabled:true,maxQueuedJobs:null,dailyGenerationLimit:null,activeJobs:0,generationsToday:3};
function api(){return {remove:vi.fn(async()=>{}),list:vi.fn(async()=>[user]),create:vi.fn(async()=>user),update:vi.fn(async(_id,body)=>({...user,...body}))};}
it('saves role, settings access, restrictions, and limits together',async()=>{
 const client=api();render(<UsersSection api={client}/>);
 fireEvent.click(await screen.findByRole('button',{name:/Member/}));
 const form=await screen.findByRole('form',{name:'Permissions for member@example.com'});
 fireEvent.click(within(form).getByLabelText('Backend settings access'));
 fireEvent.click(within(form).getByLabelText('Allow new generations'));
 fireEvent.change(within(form).getByLabelText('Queued job limit'),{target:{value:'2'}});
 fireEvent.change(within(form).getByLabelText('Daily generation limit'),{target:{value:'10'}});
 fireEvent.click(within(form).getByRole('button',{name:'Save permissions'}));
 await waitFor(()=>expect(client.update).toHaveBeenCalledWith('u1',{role:'user',settingsAccess:true,suspended:false,generationEnabled:false,maxQueuedJobs:2,dailyGenerationLimit:10}));
 expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
});
it('surfaces last-administrator protection without claiming success',async()=>{
 const client=api();client.update.mockRejectedValue(new Error('Keep at least one active administrator.'));
 render(<UsersSection api={client}/>);fireEvent.click(await screen.findByRole('button',{name:/Member/}));
 fireEvent.click(screen.getByRole('button',{name:'Save permissions'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('Keep at least one active administrator.');
 expect(screen.queryByText('Saved.')).not.toBeInTheDocument();
});
it('creates an account without modifying existing users or signing out the admin',async()=>{
 const client=api();client.create.mockResolvedValue({...user,id:'u2',email:'new@example.com'});
 render(<UsersSection api={client}/>);fireEvent.click(await screen.findByRole('button',{name:/Member/}));
 fireEvent.click(screen.getByRole('button',{name:'Add user'}));
 fireEvent.change(screen.getByLabelText('Email'),{target:{value:'new@example.com'}});
 fireEvent.change(screen.getByLabelText('Display name'),{target:{value:'New'}});
 fireEvent.change(screen.getByLabelText('Password'),{target:{value:'test password'}});
 fireEvent.click(screen.getByRole('button',{name:'Create user'}));
 await waitFor(()=>expect(client.create).toHaveBeenCalledWith({email:'new@example.com',displayName:'New',password:'test password'}));
 expect(client.update).not.toHaveBeenCalled();
});

it('starts condensed and requires confirmation before deletion',async()=>{
 const client=api();render(<UsersSection api={client}/>);
 const summary=await screen.findByRole('button',{name:/Member/});expect(summary).toHaveAttribute('aria-expanded','false');expect(screen.queryByRole('form')).not.toBeInTheDocument();
 fireEvent.click(summary);fireEvent.click(screen.getByRole('button',{name:'Delete user'}));expect(client.remove).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Confirm delete user'}));await waitFor(()=>expect(client.remove).toHaveBeenCalledWith('u1'));await waitFor(()=>expect(screen.queryByText('Member')).not.toBeInTheDocument());
});
