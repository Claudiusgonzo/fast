import { FASTElementDefinition } from "./fast-definitions";
import { ElementView } from "./view";
import { PropertyChangeNotifier } from "./observation/notifier";
import { defaultExecutionContext, Observable } from "./observation/observable";
import { Behavior } from "./directives/behavior";
import { ElementStyles } from "./styles";
import { Mutable } from "./interfaces";
import { ElementViewTemplate } from "./template";

const shadowRoots = new WeakMap<HTMLElement, ShadowRoot>();
const defaultEventOptions: CustomEventInit = {
    bubbles: true,
    composed: true,
};

function getShadowRoot(element: HTMLElement): ShadowRoot | null {
    return element.shadowRoot || shadowRoots.get(element) || null;
}

/**
 * Controls the lifecycle and rendering of a `FASTElement`.
 * @public
 */
export class Controller extends PropertyChangeNotifier {
    private boundObservables: Record<string, any> | null = null;
    private behaviors: Behavior[] | null = null;
    private needsInitialization = true;
    private _template: ElementViewTemplate | null = null;

    /**
     * The element being controlled by this controller.
     */
    public readonly element: HTMLElement;

    /**
     * The element definition that instructs this controller
     * in how to handle rendering and other platform integrations.
     */
    public readonly definition: FASTElementDefinition;

    /**
     * The view associated with the custom element.
     * @remarks
     * If `null` then the element is managing its own rendering.
     */
    public readonly view: ElementView | null = null;

    /**
     * Indicates whether or not the custom element has been
     * connected to the document.
     */
    public readonly isConnected: boolean = false;

    get template() {
        return this._template;
    }

    set template(value: ElementViewTemplate | null) {
        if (this._template === value) {
            return;
        }

        this._template = value;

        if (!this.needsInitialization) {
            this.renderTemplate(value);
        }
    }

    /**
     * Creates a Controller to control the specified element.
     * @param element - The element to be controlled by this controller.
     * @param definition - The element definition metadata that instructs this
     * controller in how to handle rendering and other platform integrations.
     * @internal
     */
    public constructor(element: HTMLElement, definition: FASTElementDefinition) {
        super(element);
        this.element = element;
        this.definition = definition;

        const shadowOptions = definition.shadowOptions;

        if (shadowOptions !== void 0) {
            const shadowRoot = element.attachShadow(shadowOptions);

            if (shadowOptions.mode === "closed") {
                shadowRoots.set(element, shadowRoot);
            }
        }

        // Capture any observable values that were set by the binding engine before
        // the browser upgraded the element. Then delete the property since it will
        // shadow the getter/setter that is required to make the observable operate.
        // Later, in the connect callback, we'll re-apply the values.
        const accessors = Observable.getAccessors(element);

        if (accessors.length > 0) {
            const boundObservables = (this.boundObservables = Object.create(null));

            for (let i = 0, ii = accessors.length; i < ii; ++i) {
                const propertyName = accessors[i].name;
                const value = (element as any)[propertyName];

                if (value !== void 0) {
                    delete (element as any)[propertyName];
                    boundObservables[propertyName] = value;
                }
            }
        }
    }

    /**
     * Adds styles to this element.
     * @param styles - The styles to add.
     */
    public addStyles(styles: ElementStyles): void {
        const target = getShadowRoot(this.element);

        if (target !== null) {
            styles.addStylesTo(target);
        }

        const sourceBehaviors = styles.behaviors;

        if (sourceBehaviors !== null) {
            this.addBehaviors(sourceBehaviors);
        }
    }

    /**
     * Removes styles from this element.
     * @param styles - the styles to remove.
     */
    public removeStyles(styles: ElementStyles): void {
        const target = getShadowRoot(this.element);

        if (target !== null) {
            styles.removeStylesFrom(target);
        }

        const sourceBehaviors = styles.behaviors;

        if (sourceBehaviors !== null) {
            this.removeBehaviors(sourceBehaviors);
        }
    }

    /**
     * Adds behaviors to this element.
     * @param behaviors - The behaviors to add.
     */
    public addBehaviors(behaviors: ReadonlyArray<Behavior>): void {
        const targetBehaviors = this.behaviors || (this.behaviors = []);
        const length = behaviors.length;

        for (let i = 0; i < length; ++i) {
            targetBehaviors.push(behaviors[i]);
        }

        if (this.isConnected) {
            const element = this.element;

            for (let i = 0; i < length; ++i) {
                behaviors[i].bind(element, defaultExecutionContext);
            }
        }
    }

    /**
     * Removes behaviors from this element.
     * @param behaviors - The behaviors to remove.
     */
    public removeBehaviors(behaviors: ReadonlyArray<Behavior>): void {
        const targetBehaviors = this.behaviors;

        if (targetBehaviors === null) {
            return;
        }

        const length = behaviors.length;

        for (let i = 0; i < length; ++i) {
            const index = targetBehaviors.indexOf(behaviors[i]);

            if (index !== -1) {
                targetBehaviors.splice(index, 1);
            }
        }

        if (this.isConnected) {
            const element = this.element;

            for (let i = 0; i < length; ++i) {
                behaviors[i].unbind(element);
            }
        }
    }

    /**
     * Runs connected lifecycle behavior on the associated element.
     */
    public onConnectedCallback(): void {
        if (this.isConnected) {
            return;
        }

        const element = this.element;

        if (this.needsInitialization) {
            this.finalizeInitialization();
        } else if (this.view !== null) {
            this.view.bind(element, defaultExecutionContext);
        }

        const behaviors = this.behaviors;

        if (behaviors !== null) {
            for (let i = 0, ii = behaviors.length; i < ii; ++i) {
                behaviors[i].bind(element, defaultExecutionContext);
            }
        }

        (this as Mutable<Controller>).isConnected = true;
    }

    /**
     * Runs disconnected lifecycle behavior on the associated element.
     */
    public onDisconnectedCallback(): void {
        if (this.isConnected === false) {
            return;
        }

        (this as Mutable<Controller>).isConnected = false;

        const view = this.view;

        if (view !== null) {
            view.unbind();
        }

        const behaviors = this.behaviors;

        if (behaviors !== null) {
            const element = this.element;

            for (let i = 0, ii = behaviors.length; i < ii; ++i) {
                behaviors[i].unbind(element);
            }
        }
    }

    /**
     * Runs the attribute changed callback for the associated element.
     * @param name - The name of the attribute that changed.
     * @param oldValue - The previous value of the attribute.
     * @param newValue - The new value of the attribute.
     */
    public onAttributeChangedCallback(
        name: string,
        oldValue: string,
        newValue: string
    ): void {
        const attrDef = this.definition.attributeLookup[name];

        if (attrDef !== void 0) {
            attrDef.onAttributeChangedCallback(this.element, newValue);
        }
    }

    /**
     * Emits a custom HTML event.
     * @param type - The type name of the event.
     * @param detail - The event detail object to send with the event.
     * @param options - The event options. By default bubbles and composed.
     * @remarks
     * Only emits events if connected.
     */
    public emit(
        type: string,
        detail?: any,
        options?: Omit<CustomEventInit, "detail">
    ): void | boolean {
        if (this.isConnected) {
            return this.element.dispatchEvent(
                new CustomEvent(type, { detail, ...defaultEventOptions, ...options })
            );
        }

        return false;
    }

    private finalizeInitialization() {
        const element = this.element;
        const boundObservables = this.boundObservables;

        // If we have any observables that were bound, re-apply their values.
        if (boundObservables !== null) {
            const propertyNames = Object.keys(boundObservables);

            for (let i = 0, ii = propertyNames.length; i < ii; ++i) {
                const propertyName = propertyNames[i];
                (element as any)[propertyName] = boundObservables[propertyName];
            }

            this.boundObservables = null;
        }

        const definition = this.definition;
        const styles = definition.styles;

        if (this._template === null) {
            if ((this.element as any).resolveTemplate) {
                this._template = (this.element as any).resolveTemplate();
            } else if (definition.template) {
                this._template = definition.template || null;
            }
        }

        if (this._template !== null) {
            this.renderTemplate(this._template);
        }

        if (styles !== void 0) {
            this.addStyles(styles);
        }

        this.needsInitialization = false;
    }

    private renderTemplate(template: ElementViewTemplate | null | undefined) {
        const element = this.element;
        const host = getShadowRoot(element) || element;

        if (this.view !== null) {
            this.view.dispose();
            (this as Mutable<this>).view = null;
        } else if (!this.needsInitialization) {
            host.innerHTML = "";
        }

        if (template) {
            // we have a new template to render to the Light
            (this as Mutable<this>).view = template.render(element, host, element);
        }
    }

    /**
     * Locates or creates a controller for the specified element.
     * @param element - The element to return the controller for.
     * @remarks
     * The specified element must have a {@link FASTElementDefinition}
     * registered either through the use of the {@link customElement}
     * decorator or a call to `FASTElement.define`.
     */
    public static forCustomElement(element: HTMLElement): Controller {
        const controller: Controller = (element as any).$fastController;

        if (controller !== void 0) {
            return controller;
        }

        const definition = FASTElementDefinition.forType(element.constructor);

        if (definition === void 0) {
            throw new Error("Missing FASTElement definition.");
        }

        return ((element as any).$fastController = new Controller(element, definition));
    }
}
