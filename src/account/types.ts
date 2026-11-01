export interface Profile {
  id: string;
  username: string;
  display_name: string;
}
export interface ConnectionRequest {
  id: string;
  requester_id: string;
  recipient_id: string;
  status: string;
  created_at: string;
  person: Profile;
}
export interface Connections {
  friends: Profile[];
  incoming: ConnectionRequest[];
  outgoing: ConnectionRequest[];
  blocked: { id: string; display_name: string; username: string }[];
}
