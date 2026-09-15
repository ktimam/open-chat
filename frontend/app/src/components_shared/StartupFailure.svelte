<script lang="ts">
    let { message, recovery = "reload" }: { message: string; recovery?: "reload" | "new-tab" } =
        $props();
</script>

<div class="startup-failure" role="alert">
    <p>{message}</p>
    {#if recovery === "new-tab"}
        <p class="guidance">Open a fresh tab, then close this stale tab.</p>
        <button onclick={() => window.open(window.location.href, "_blank", "noopener")}
            >Open in a new tab</button
        >
    {:else}
        <button onclick={() => window.location.reload()}>Reload</button>
    {/if}
</div>

<style lang="scss">
    .startup-failure {
        box-sizing: border-box;
        width: 100vw;
        min-height: 100vh;
        min-height: 100dvh;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: $sp5;
        padding: $sp7;
        text-align: center;
        color: var(--txt);
        background: var(--bg);
    }

    p {
        max-width: 32rem;
        margin: 0;
    }

    .guidance {
        opacity: 0.8;
    }

    button {
        min-width: 7rem;
        padding: $sp3 $sp5;
        border: 0;
        border-radius: $sp2;
        color: var(--button-txt);
        background: var(--button-bg);
        cursor: pointer;
    }
</style>
