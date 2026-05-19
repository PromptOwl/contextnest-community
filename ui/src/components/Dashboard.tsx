/**
 * Dashboard — landing page with server info + nest list.
 */
import React, { useState, useEffect } from "react";
import * as api from "../lib/api";
import {
  FileText, Plus, Database, Copy, Check, Bot, Monitor, Terminal, Globe,
} from "lucide-react";

const ANON_USER_ID = "00000000-0000-0000-0000-000000000000";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface DashboardProps {
  onSelectNest: (nestId: string, name: string) => void;
}

export function Dashboard({ onSelectNest }: DashboardProps) {
  const [nests, setNests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");

  const serverUrl =
    typeof window !== "undefined" ? window.location.origin : "http://localhost:3838";

  const fetchNests = async () => {
    setLoading(true);
    try {
      const data = await api.listNests();
      setNests(data.nests);
    } catch {} finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchNests(); }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      await api.createNest(newName, newDesc);
      setNewName(""); setNewDesc(""); setShowCreate(false);
      fetchNests();
    } catch {}
  };

  return (
    <div className="space-y-6">
      {/* Server info banner */}
      <Card className="bg-gradient-to-br from-blue-50 to-indigo-50 border-blue-200">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between">
            <div>
              <CardTitle className="text-lg">Your Community Server</CardTitle>
              <CardDescription>
                Running at{" "}
                <code className="text-xs bg-white/60 px-1.5 py-0.5 rounded font-mono">
                  {serverUrl}
                </code>
                <CopyInline value={serverUrl} />
              </CardDescription>
            </div>
            <div className="flex gap-4 text-center">
              <div>
                <div className="text-2xl font-bold">{nests.length}</div>
                <div className="text-xs text-muted-foreground">Nests</div>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="grid md:grid-cols-3 gap-3 text-xs">
            <ClientHint
              icon={<Bot className="h-4 w-4" />}
              title="Hootie"
              desc="Settings → Vault → Remote Server → paste URL"
            />
            <ClientHint
              icon={<Monitor className="h-4 w-4" />}
              title="Claude Desktop"
              desc="Add MCP endpoint per nest via Connect button"
            />
            <ClientHint
              icon={<Terminal className="h-4 w-4" />}
              title="CLI"
              desc={`ctx --server ${serverUrl}`}
              mono
            />
          </div>
        </CardContent>
      </Card>

      {/* Nests header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Nests</h2>
          <p className="text-sm text-muted-foreground">
            Shared knowledge vaults for your team
          </p>
        </div>
        <Button onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4 mr-2" />
          New Nest
        </Button>
      </div>

      {/* Create form */}
      {showCreate && (
        <Card>
          <CardContent className="pt-6">
            <form onSubmit={handleCreate} className="space-y-3">
              <div className="space-y-1">
                <Label>Name</Label>
                <Input
                  placeholder="Team Knowledge"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="space-y-1">
                <Label>Description (optional)</Label>
                <Input
                  placeholder="Shared docs for the engineering team"
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                />
              </div>
              <div className="flex gap-2">
                <Button type="submit">Create Nest</Button>
                <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Nest list */}
      {loading ? (
        <div className="text-center py-12 text-muted-foreground">Loading...</div>
      ) : nests.length === 0 ? (
        <Card>
          <CardContent className="text-center py-12">
            <Database className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
            <p className="font-medium">No nests yet</p>
            <p className="text-sm text-muted-foreground mb-4">
              Create your first nest to start sharing knowledge with your team
            </p>
            <Button onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Create First Nest
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {nests.map((nest) => {
            const isAnonymous = nest.user_id === ANON_USER_ID;
            return (
              <button
                key={nest.id}
                onClick={() => onSelectNest(nest.id, nest.name)}
                className={`text-left p-4 rounded-lg border bg-card hover:bg-secondary/50 transition-colors ${
                  isAnonymous
                    ? "border-dashed border-amber-300"
                    : "border-border"
                }`}
              >
                <div className="flex items-start gap-3">
                  <div
                    className={`p-2 rounded-md ${
                      isAnonymous ? "bg-amber-100" : "bg-primary/10"
                    }`}
                  >
                    {isAnonymous ? (
                      <Globe className="h-5 w-5 text-amber-700" />
                    ) : (
                      <FileText className="h-5 w-5 text-primary" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-medium truncate">{nest.name}</h3>
                    {nest.description && (
                      <p className="text-sm text-muted-foreground truncate mt-0.5">
                        {nest.description}
                      </p>
                    )}
                    <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground flex-wrap">
                      {isAnonymous && (
                        <span
                          className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200"
                          title="Owned by the anonymous admin — no stewardship applied"
                        >
                          Ungoverned
                        </span>
                      )}
                      <span
                        className={`px-1.5 py-0.5 rounded ${
                          nest.visibility === "public"
                            ? "bg-green-100 text-green-700"
                            : "bg-secondary text-secondary-foreground"
                        }`}
                      >
                        {nest.visibility}
                      </span>
                      <span>{new Date(nest.created_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ClientHint({
  icon,
  title,
  desc,
  mono,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start gap-2 p-2 rounded bg-white/40">
      <div className="text-muted-foreground mt-0.5">{icon}</div>
      <div className="min-w-0">
        <div className="font-medium text-foreground">{title}</div>
        <div className={`text-muted-foreground ${mono ? "font-mono text-[10px]" : ""} truncate`}>
          {desc}
        </div>
      </div>
    </div>
  );
}

function CopyInline({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async (e) => {
        e.stopPropagation();
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="ml-1 inline-flex items-center hover:text-foreground"
    >
      {copied ? (
        <Check className="h-3 w-3 text-green-600" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </button>
  );
}
